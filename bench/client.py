"""
The measured client.

Every model call in the harness goes through here, which is why capture is
automatic rather than something test code has to remember. Timing is taken
around a streaming request so TTFT is real (the moment the first content
token lands), not inferred from total latency.

Works against OpenRouter or any OpenAI-compatible endpoint, unchanged.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from typing import Any

import httpx

from .registry import ANTHROPIC_BASE, ANTHROPIC_VERSION, ModelSpec
from .schema import RunRecord


def sha8(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:8]


def _is_max_tokens_param_error(rec: RunRecord) -> bool:
    """True for OpenAI's `max_tokens` rejection on newer models, e.g.:
    'Unsupported parameter: max_tokens is not supported with this model.
    Use max_completion_tokens instead.'"""
    if rec.http_status != 400:
        return False
    msg = rec.error_message or ""
    return "max_tokens" in msg and "max_completion_tokens" in msg


class MeasuredClient:
    def __init__(self, *, retry_attempts: int = 2, retry_backoff_s: float = 2.0,
                 mock: bool = False):
        self.retry_attempts = retry_attempts
        self.retry_backoff_s = retry_backoff_s
        self.mock = mock
        self._client: httpx.AsyncClient | None = None
        # Models (by alias) known to reject `max_tokens` and require
        # `max_completion_tokens` instead -- OpenAI's o-series and GPT-5
        # generation, called direct rather than through a gateway that
        # normalises this. Learned on first failure per model rather than
        # matched by name, so the next model generation with the same
        # quirk doesn't need a code change here.
        self._needs_max_completion_tokens: set[str] = set()

    async def __aenter__(self):
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=15.0))
        return self

    async def __aexit__(self, *exc):
        if self._client:
            await self._client.aclose()

    # ── public ────────────────────────────────────────────────────────
    async def complete(
        self,
        spec: ModelSpec,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict] | None = None,
        response_format: dict | None = None,
        max_tokens: int | None = None,
    ) -> RunRecord:
        """Make one measured call. Never raises: failures come back as a record."""
        rec = self._blank_record(spec, messages, tools, max_tokens)

        if self.mock:
            return await self._mock_call(rec, spec, messages)

        if not spec.is_ready:
            rec.ok = False
            rec.error_type = "missing_credentials"
            rec.error_message = self._missing_credentials_message(spec)
            return rec

        if spec.route == "bedrock":
            return await self._bedrock_complete(rec, spec, messages, max_tokens)
        if spec.route == "anthropic":
            return await self._anthropic_complete(rec, spec, messages, tools, max_tokens)

        attempt = 0
        retry_started = time.perf_counter()
        swapped_tokens_key = False
        while attempt <= self.retry_attempts:
            try:
                await self._stream_once(rec, spec, messages, tools,
                                        response_format, max_tokens)
                if rec.ok:
                    rec.retry_count = attempt
                    if attempt:
                        rec.queue_or_retry_ms = (time.perf_counter() - retry_started) * 1000
                    await self._enrich_from_generation_endpoint(rec, spec)
                    self._compute_cost(rec, spec)
                    return rec
                if not swapped_tokens_key and _is_max_tokens_param_error(rec):
                    # Not a transient failure -- retry immediately with the
                    # corrected parameter name, same attempt, no backoff.
                    # Gated on a local flag rather than membership in
                    # _needs_max_completion_tokens: under concurrency, a
                    # sibling call for the same model may have already
                    # flagged it after this one was dispatched with the old
                    # key, so "already flagged" must not mean "already
                    # retried this call".
                    swapped_tokens_key = True
                    self._needs_max_completion_tokens.add(spec.id)
                    continue
                # 429 and 5xx are worth retrying; 4xx is not
                if rec.http_status and rec.http_status < 500 and rec.http_status != 429:
                    break
            except Exception as exc:
                rec.error_type = type(exc).__name__
                rec.error_message = str(exc)[:400]
                rec.ok = False

            attempt += 1
            if attempt <= self.retry_attempts:
                await asyncio.sleep(self.retry_backoff_s * attempt)

        rec.retry_count = attempt
        rec.queue_or_retry_ms = (time.perf_counter() - retry_started) * 1000
        return rec

    # ── internals ─────────────────────────────────────────────────────
    @staticmethod
    def _missing_credentials_message(spec: ModelSpec) -> str:
        if spec.route == "bedrock":
            return (
                f"AWS credentials not resolved for route=bedrock (expected env "
                f"{spec.aws_access_key_id_env or 'AWS_ACCESS_KEY_ID'} / "
                f"{spec.aws_secret_access_key_env or 'AWS_SECRET_ACCESS_KEY'}, "
                f"region={spec.region or '<unset>'})"
            )
        default_env = "ANTHROPIC_API_KEY" if spec.route == "anthropic" else "OPENROUTER_API_KEY"
        return (
            f"no API key resolved for route={spec.route} "
            f"(expected env {spec.api_key_env or default_env})"
        )

    def _blank_record(self, spec, messages, tools, max_tokens) -> RunRecord:
        system = next((m["content"] for m in messages if m.get("role") == "system"), "")
        return RunRecord(
            record_id=str(uuid.uuid4()),
            model_alias=spec.id,
            model_requested=spec.model,
            model_canonical_id=spec.canonical_id,
            vendor=spec.vendor,
            model_family=spec.model_family,
            is_open_weight=spec.is_open_weight,
            context_window=spec.context_window,
            max_output_tokens=spec.max_output_tokens,
            supports_tools=spec.supports_tools,
            supports_json_mode=spec.supports_json_mode,
            supports_reasoning=spec.supports_reasoning,
            supports_prompt_caching=spec.supports_prompt_caching,
            input_modalities=",".join(spec.input_modalities),
            tokenizer=spec.tokenizer,
            price_input_per_mtok=spec.price_input_per_mtok,
            price_cached_input_per_mtok=spec.price_cached_input_per_mtok,
            price_output_per_mtok=spec.price_output_per_mtok,
            price_reasoning_per_mtok=spec.price_reasoning_per_mtok,
            pricing_captured_at=spec.pricing_captured_at,
            route=spec.route,
            endpoint_base_url=spec.base_url,
            region=spec.region,
            deployment_type=spec.deployment_type,
            tags=",".join(spec.tags),
            # Only a direct vendor call yields latency you may quote as absolute.
            latency_authoritative=(spec.route in ("direct", "bedrock", "anthropic")),
            temperature=spec.temperature,
            top_p=spec.top_p,
            max_tokens_requested=max_tokens or spec.max_tokens,
            seed=spec.seed,
            system_prompt_sha=sha8(str(system)),
            tools_offered=len(tools or []),
            turn_count=sum(1 for m in messages if m.get("role") == "user"),
            ci=bool(os.getenv("GITHUB_ACTIONS")),
            git_sha=os.getenv("GITHUB_SHA", "")[:8],
        )

    # ── Bedrock (not OpenAI-compatible -- SigV4, not a bearer token; the
    # Converse API's own request/response shape, not /chat/completions) ────
    _BEDROCK_RETRYABLE = {
        "ThrottlingException", "ModelNotReadyException",
        "ServiceUnavailableException", "InternalServerException",
    }

    async def _bedrock_complete(self, rec: RunRecord, spec: ModelSpec,
                                messages: list[dict[str, Any]], max_tokens: int | None) -> RunRecord:
        """Non-streaming Converse only (v1): ConverseStream uses AWS's binary
        vnd.amazon.eventstream framing, not the SSE this harness otherwise
        parses -- a real parser for later, not this pass. Bedrock rows get
        real total_latency_ms; ttft_ms stays null, a documented gap rather
        than an inferred or faked number."""
        attempt = 0
        retry_started = time.perf_counter()
        while attempt <= self.retry_attempts:
            try:
                await self._bedrock_once(rec, spec, messages, max_tokens)
                if rec.ok:
                    rec.retry_count = attempt
                    if attempt:
                        rec.queue_or_retry_ms = (time.perf_counter() - retry_started) * 1000
                    self._compute_cost(rec, spec)
                    return rec
                if rec.error_type not in self._BEDROCK_RETRYABLE:
                    break
            except Exception as exc:
                rec.ok = False
                rec.error_type = type(exc).__name__
                rec.error_message = str(exc)[:400]

            attempt += 1
            if attempt <= self.retry_attempts:
                await asyncio.sleep(self.retry_backoff_s * attempt)

        rec.retry_count = attempt
        rec.queue_or_retry_ms = (time.perf_counter() - retry_started) * 1000
        return rec

    async def _bedrock_once(self, rec: RunRecord, spec: ModelSpec,
                            messages: list[dict[str, Any]], max_tokens: int | None) -> None:
        rec.error_type = ""
        rec.error_message = ""

        def _call():
            import boto3
            client = boto3.client(
                "bedrock-runtime",
                region_name=spec.region,
                aws_access_key_id=spec.aws_access_key_id,
                aws_secret_access_key=spec.aws_secret_access_key,
                aws_session_token=spec.aws_session_token or None,
            )
            bedrock_messages = []
            system_blocks = []
            for m in messages:
                content = str(m.get("content", ""))
                if m.get("role") == "system":
                    system_blocks.append({"text": content})
                else:
                    bedrock_messages.append({"role": m["role"], "content": [{"text": content}]})

            inference_config: dict[str, Any] = {"maxTokens": max_tokens or spec.max_tokens,
                                                 "temperature": spec.temperature}
            if spec.top_p is not None:
                inference_config["topP"] = spec.top_p

            kwargs: dict[str, Any] = {
                "modelId": spec.model,
                "messages": bedrock_messages,
                "inferenceConfig": inference_config,
            }
            if system_blocks:
                kwargs["system"] = system_blocks
            return client.converse(**kwargs)

        t0 = time.perf_counter()
        try:
            response = await asyncio.to_thread(_call)
        except Exception as exc:
            rec.ok = False
            # botocore's ClientError carries the real AWS error code (e.g.
            # ThrottlingException, AccessDeniedException) in .response; fall
            # back to the exception's class name for anything else (network
            # errors, NoCredentialsError, etc.)
            code = getattr(exc, "response", None)
            rec.error_type = (code.get("Error", {}).get("Code") if isinstance(code, dict) else None) or type(exc).__name__
            rec.error_message = str(exc)[:400]
            return

        rec.http_status = 200
        rec.total_latency_ms = (time.perf_counter() - t0) * 1000
        rec.model_served = spec.model

        content_blocks = response.get("output", {}).get("message", {}).get("content", []) or []
        rec.response_text = "".join(b.get("text", "") for b in content_blocks if "text" in b)
        rec.finish_reason = response.get("stopReason", "")

        usage = response.get("usage", {}) or {}
        rec.prompt_tokens = usage.get("inputTokens")
        rec.completion_tokens = usage.get("outputTokens")
        rec.total_tokens = usage.get("totalTokens")

        rec.ok = bool(rec.response_text)
        if not rec.ok and not rec.error_type:
            rec.error_type = "empty_response"

    # ── Anthropic (not OpenAI-compatible -- x-api-key not a bearer token,
    # POST /messages not /chat/completions, named SSE events rather than a
    # flat data: stream, system prompt is a top-level field not a message
    # with role "system", tool schema is {name,description,input_schema}
    # rather than {type:"function",function:{...}}) ──────────────────────
    async def _anthropic_complete(self, rec: RunRecord, spec: ModelSpec,
                                  messages: list[dict[str, Any]], tools: list[dict] | None,
                                  max_tokens: int | None) -> RunRecord:
        attempt = 0
        retry_started = time.perf_counter()
        while attempt <= self.retry_attempts:
            try:
                await self._anthropic_once(rec, spec, messages, tools, max_tokens)
                if rec.ok:
                    rec.retry_count = attempt
                    if attempt:
                        rec.queue_or_retry_ms = (time.perf_counter() - retry_started) * 1000
                    self._compute_cost(rec, spec)
                    return rec
                # 429 and 5xx are worth retrying; 4xx is not.
                if rec.http_status and rec.http_status < 500 and rec.http_status != 429:
                    break
            except Exception as exc:
                rec.ok = False
                rec.error_type = type(exc).__name__
                rec.error_message = str(exc)[:400]

            attempt += 1
            if attempt <= self.retry_attempts:
                await asyncio.sleep(self.retry_backoff_s * attempt)

        rec.retry_count = attempt
        rec.queue_or_retry_ms = (time.perf_counter() - retry_started) * 1000
        return rec

    async def _anthropic_once(self, rec: RunRecord, spec: ModelSpec,
                              messages: list[dict[str, Any]], tools: list[dict] | None,
                              max_tokens: int | None) -> None:
        rec.error_type = ""
        rec.error_message = ""

        # Anthropic takes the system prompt as a top-level field, never as a
        # message in the array -- and rejects a messages array containing one.
        system = next((m["content"] for m in messages if m.get("role") == "system"), "")
        convo = [m for m in messages if m.get("role") != "system"]

        base_url = spec.base_url or ANTHROPIC_BASE
        headers = {
            "x-api-key": spec.api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }
        payload: dict[str, Any] = {
            "model": spec.model,
            "messages": convo,
            "max_tokens": max_tokens or spec.max_tokens,
            "temperature": spec.temperature,
            "stream": True,
        }
        if system:
            payload["system"] = system
        if spec.top_p is not None:
            payload["top_p"] = spec.top_p
        if tools:
            # OpenAI-shaped {type:"function", function:{name,description,parameters}}
            # -> Anthropic-shaped {name, description, input_schema}.
            payload["tools"] = [
                {
                    "name": t["function"]["name"],
                    "description": t["function"].get("description", ""),
                    "input_schema": t["function"].get("parameters") or {"type": "object", "properties": {}},
                }
                for t in tools if t.get("type") == "function" and "function" in t
            ]

        chunks: list[str] = []
        tool_calls: dict[int, dict] = {}
        tool_json_buf: dict[int, str] = {}
        first_token_at: float | None = None
        input_tokens: int | None = None
        output_tokens: int | None = None
        cache_read_tokens: int | None = None
        stop_reason = ""
        event_type = ""

        t0 = time.perf_counter()
        async with self._client.stream("POST", f"{base_url}/messages", headers=headers,
                                       json=payload, timeout=spec.timeout_s) as resp:
            rec.http_status = resp.status_code
            rec.rate_limited = resp.status_code == 429

            if resp.status_code != 200:
                body = (await resp.aread()).decode(errors="replace")[:400]
                rec.ok = False
                rec.error_type = f"http_{resp.status_code}"
                rec.error_message = body
                return

            async for line in resp.aiter_lines():
                if not line:
                    continue
                if line.startswith("event: "):
                    event_type = line[7:].strip()
                    continue
                if not line.startswith("data: "):
                    continue
                try:
                    evt = json.loads(line[6:].strip())
                except json.JSONDecodeError:
                    continue

                if event_type == "message_start":
                    msg = evt.get("message", {}) or {}
                    usage = msg.get("usage", {}) or {}
                    input_tokens = usage.get("input_tokens")
                    cache_read_tokens = usage.get("cache_read_input_tokens")
                    rec.model_served = msg.get("model") or rec.model_served
                elif event_type == "content_block_start":
                    block = evt.get("content_block", {}) or {}
                    idx = evt.get("index", 0)
                    if block.get("type") == "tool_use":
                        tool_calls[idx] = {"name": block.get("name", ""), "arguments": "", "id": block.get("id", "")}
                        tool_json_buf[idx] = ""
                elif event_type == "content_block_delta":
                    idx = evt.get("index", 0)
                    delta = evt.get("delta", {}) or {}
                    if delta.get("type") == "text_delta":
                        text = delta.get("text", "")
                        if text:
                            if first_token_at is None:
                                first_token_at = time.perf_counter()
                            chunks.append(text)
                    elif delta.get("type") == "input_json_delta":
                        if first_token_at is None:
                            first_token_at = time.perf_counter()
                        tool_json_buf[idx] = tool_json_buf.get(idx, "") + (delta.get("partial_json") or "")
                elif event_type == "message_delta":
                    usage = evt.get("usage", {}) or {}
                    if usage.get("output_tokens") is not None:
                        output_tokens = usage["output_tokens"]
                    delta = evt.get("delta", {}) or {}
                    stop_reason = delta.get("stop_reason") or stop_reason
                elif event_type == "error":
                    err = evt.get("error", {}) or {}
                    rec.ok = False
                    rec.error_type = err.get("type", "anthropic_error")
                    rec.error_message = (err.get("message") or "")[:400]
                    return

        for idx, buf in tool_json_buf.items():
            tool_calls[idx]["arguments"] = buf or "{}"

        t_end = time.perf_counter()
        rec.total_latency_ms = (t_end - t0) * 1000
        if first_token_at is not None:
            rec.ttft_ms = (first_token_at - t0) * 1000
        rec.response_text = "".join(chunks)
        if tool_calls:
            rec.tool_calls_json = json.dumps([tool_calls[k] for k in sorted(tool_calls)], ensure_ascii=False)
        rec.finish_reason = stop_reason

        rec.prompt_tokens = input_tokens
        rec.completion_tokens = output_tokens
        if input_tokens is not None and output_tokens is not None:
            rec.total_tokens = input_tokens + output_tokens
        if cache_read_tokens:
            rec.cached_prompt_tokens = cache_read_tokens
            if rec.prompt_tokens:
                rec.cache_hit_ratio = cache_read_tokens / rec.prompt_tokens

        if rec.completion_tokens and rec.completion_tokens > 1 and rec.ttft_ms is not None:
            gen_ms = rec.total_latency_ms - rec.ttft_ms
            rec.tpot_ms = gen_ms / max(rec.completion_tokens - 1, 1)
            if rec.total_latency_ms > 0:
                rec.tokens_per_second = rec.completion_tokens / (rec.total_latency_ms / 1000)

        rec.ok = bool(rec.response_text or rec.tool_calls_json)
        if not rec.ok and not rec.error_type:
            rec.error_type = "empty_response"

    async def _stream_once(self, rec, spec, messages, tools,
                           response_format, max_tokens) -> None:
        # A retried attempt reuses the same record; clear the previous
        # attempt's failure so a later success doesn't keep stale error text.
        rec.error_type = ""
        rec.error_message = ""

        url = f"{spec.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {spec.api_key}",
            "Content-Type": "application/json",
        }
        if spec.route == "openrouter":
            # Courtesy headers; also how OpenRouter attributes usage.
            headers["HTTP-Referer"] = "https://github.com/local/modelbench"
            headers["X-Title"] = "modelbench"

        tokens_key = ("max_completion_tokens" if spec.id in self._needs_max_completion_tokens
                      else "max_tokens")
        payload: dict[str, Any] = {
            "model": spec.model,
            "messages": messages,
            "temperature": spec.temperature,
            tokens_key: max_tokens or spec.max_tokens,
            "stream": True,
            # Ask the gateway to include usage in the final stream chunk.
            "stream_options": {"include_usage": True},
        }
        if spec.top_p is not None:
            payload["top_p"] = spec.top_p
        if spec.seed is not None:
            payload["seed"] = spec.seed
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if response_format:
            payload["response_format"] = response_format

        chunks: list[str] = []
        tool_calls: dict[int, dict] = {}
        first_token_at: float | None = None
        usage: dict[str, Any] = {}
        gen_id = ""

        t0 = time.perf_counter()
        async with self._client.stream("POST", url, headers=headers,
                                       json=payload, timeout=spec.timeout_s) as resp:
            rec.http_status = resp.status_code
            rec.rate_limited = resp.status_code == 429

            if resp.status_code != 200:
                body = (await resp.aread()).decode(errors="replace")[:400]
                rec.ok = False
                rec.error_type = f"http_{resp.status_code}"
                rec.error_message = body
                return

            async for line in resp.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                data = line[6:].strip()
                if data == "[DONE]":
                    break
                try:
                    evt = json.loads(data)
                except json.JSONDecodeError:
                    continue

                gen_id = evt.get("id") or gen_id
                if evt.get("usage"):
                    usage = evt["usage"]
                if evt.get("model"):
                    rec.model_served = evt["model"]
                if evt.get("provider"):
                    rec.served_by_provider = evt["provider"]

                for choice in evt.get("choices", []) or []:
                    delta = choice.get("delta", {}) or {}
                    if choice.get("finish_reason"):
                        rec.finish_reason = choice["finish_reason"]

                    content = delta.get("content")
                    if content:
                        if first_token_at is None:
                            first_token_at = time.perf_counter()
                        chunks.append(content)

                    for tc in delta.get("tool_calls", []) or []:
                        if first_token_at is None:
                            first_token_at = time.perf_counter()
                        idx = tc.get("index", 0)
                        slot = tool_calls.setdefault(
                            idx, {"name": "", "arguments": "", "id": ""})
                        slot["id"] = tc.get("id") or slot["id"]
                        fn = tc.get("function", {}) or {}
                        slot["name"] = fn.get("name") or slot["name"]
                        slot["arguments"] += fn.get("arguments") or ""

        t_end = time.perf_counter()

        rec.total_latency_ms = (t_end - t0) * 1000
        if first_token_at is not None:
            rec.ttft_ms = (first_token_at - t0) * 1000
        rec.response_text = "".join(chunks)
        if tool_calls:
            rec.tool_calls_json = json.dumps(
                [tool_calls[k] for k in sorted(tool_calls)], ensure_ascii=False)

        self._apply_usage(rec, usage)

        if rec.completion_tokens and rec.completion_tokens > 1 and rec.ttft_ms is not None:
            gen_ms = rec.total_latency_ms - rec.ttft_ms
            rec.tpot_ms = gen_ms / max(rec.completion_tokens - 1, 1)
            if rec.total_latency_ms > 0:
                rec.tokens_per_second = rec.completion_tokens / (rec.total_latency_ms / 1000)

        rec.ok = bool(rec.response_text or rec.tool_calls_json)
        if not rec.ok and not rec.error_type:
            rec.error_type = "empty_response"
        rec._gen_id = gen_id  # type: ignore[attr-defined]

    @staticmethod
    def _apply_usage(rec: RunRecord, usage: dict[str, Any]) -> None:
        if not usage:
            return
        rec.prompt_tokens = usage.get("prompt_tokens")
        rec.completion_tokens = usage.get("completion_tokens")
        rec.total_tokens = usage.get("total_tokens")

        details = usage.get("prompt_tokens_details") or {}
        rec.cached_prompt_tokens = details.get("cached_tokens")

        comp_details = usage.get("completion_tokens_details") or {}
        rec.reasoning_tokens = comp_details.get("reasoning_tokens")

        if rec.prompt_tokens and rec.cached_prompt_tokens is not None:
            rec.cache_hit_ratio = rec.cached_prompt_tokens / rec.prompt_tokens

        # OpenRouter reports authoritative cost directly when available.
        if usage.get("cost") is not None:
            rec.cost_total_usd = float(usage["cost"])
            rec.cost_source = "gateway_reported"

    async def _enrich_from_generation_endpoint(self, rec: RunRecord,
                                               spec: ModelSpec) -> None:
        """
        OpenRouter's /generation endpoint returns the authoritative post-hoc
        record: which upstream actually served it, native token counts, and
        real cost. This is the single best source of provenance metadata, so
        it is worth the extra round trip.
        """
        gen_id = getattr(rec, "_gen_id", "")
        if spec.route != "openrouter" or not gen_id:
            return
        try:
            await asyncio.sleep(0.4)  # stats settle a moment after completion
            r = await self._client.get(
                f"{spec.base_url}/generation",
                params={"id": gen_id},
                headers={"Authorization": f"Bearer {spec.api_key}"},
                timeout=15.0,
            )
            if r.status_code != 200:
                return
            d = r.json().get("data", {}) or {}
            rec.served_by_provider = d.get("provider_name") or rec.served_by_provider
            rec.model_served = d.get("model") or rec.model_served
            if d.get("total_cost") is not None:
                rec.cost_total_usd = float(d["total_cost"])
                rec.cost_source = "gateway_reported"
            rec.prompt_tokens = d.get("tokens_prompt") or rec.prompt_tokens
            rec.completion_tokens = d.get("tokens_completion") or rec.completion_tokens
            if d.get("latency") is not None and rec.ttft_ms is None:
                rec.ttft_ms = float(d["latency"])
        except Exception:
            pass  # provenance enrichment is best-effort, never fatal

    @staticmethod
    def _compute_cost(rec: RunRecord, spec: ModelSpec) -> None:
        """Fall back to computing cost from the snapshotted price list."""
        p_in = spec.price_input_per_mtok
        p_cached = spec.price_cached_input_per_mtok
        p_out = spec.price_output_per_mtok

        cached = rec.cached_prompt_tokens or 0
        fresh = max((rec.prompt_tokens or 0) - cached, 0)

        if p_in is not None:
            rec.cost_input_usd = fresh * p_in / 1_000_000
        if p_cached is not None and cached:
            rec.cost_cached_usd = cached * p_cached / 1_000_000
        elif p_in is not None and cached:
            rec.cost_cached_usd = cached * p_in / 1_000_000
        if p_out is not None:
            rec.cost_output_usd = (rec.completion_tokens or 0) * p_out / 1_000_000

        if rec.cost_total_usd is None:
            parts = [rec.cost_input_usd, rec.cost_cached_usd, rec.cost_output_usd]
            if any(p is not None for p in parts):
                rec.cost_total_usd = sum(p for p in parts if p is not None)
                rec.cost_source = "computed_from_catalogue"

    async def _mock_call(self, rec: RunRecord, spec: ModelSpec,
                         messages: list[dict]) -> RunRecord:
        """Offline mode: exercises the whole pipeline with no keys and no spend."""
        import random
        await asyncio.sleep(random.uniform(0.01, 0.05))
        last = next((m["content"] for m in reversed(messages)
                     if m.get("role") == "user"), "")
        rec.model_served = spec.model
        rec.served_by_provider = "mock"
        rec.ttft_ms = random.uniform(120, 400)
        rec.total_latency_ms = rec.ttft_ms + random.uniform(100, 900)
        rec.prompt_tokens = max(len(str(last).split()) * 2, 20)
        rec.cached_prompt_tokens = 0
        rec.completion_tokens = random.randint(20, 120)
        rec.total_tokens = rec.prompt_tokens + rec.completion_tokens
        rec.tokens_per_second = rec.completion_tokens / (rec.total_latency_ms / 1000)
        rec.tpot_ms = (rec.total_latency_ms - rec.ttft_ms) / max(rec.completion_tokens - 1, 1)
        rec.response_text = f"[mock:{spec.id}] acknowledged: {str(last)[:80]}"
        rec.finish_reason = "stop"
        rec.http_status = 200
        rec.ok = True
        self._compute_cost(rec, spec)
        if rec.cost_total_usd is None:
            rec.cost_total_usd = 0.0
            rec.cost_source = "mock"
        return rec
