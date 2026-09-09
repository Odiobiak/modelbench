"""
Real credential verification.

`ModelSpec.is_ready` (registry.py) only checks that a base_url and api_key
resolved to non-empty strings -- it says nothing about whether the key
actually works. A placeholder left in .env (`OPENROUTER_API_KEY=sk-or-v1-...`)
reads as "ready" under that check and only fails once you spend a real call
on it.

This does one cheap, zero-completion-token call per provider instead:
OpenRouter's authenticated key-info endpoint for route=openrouter (proves the
key itself, not just that some model list is public), or the provider's own
`GET {base_url}/models` for a direct route -- every OpenAI-compatible
endpoint supports this and it costs no output tokens.

Deliberately not run automatically when the registry loads: verification is
a network call per model, so it happens only when asked for (a "Verify"
click, or `verify-all`), not on every page view.
"""
from __future__ import annotations

import asyncio

import httpx

from .registry import ANTHROPIC_VERSION, ModelSpec

_TIMEOUT_S = 15.0


async def verify_credentials(spec: ModelSpec) -> tuple[bool, str]:
    """Returns (ok, message). Never raises -- a failure to verify is a
    result ("unreachable", "invalid key"), not an exception for the caller
    to handle."""
    if not spec.is_ready:
        if spec.route == "bedrock":
            return False, (
                f"AWS credentials not resolved (expected env "
                f"{spec.aws_access_key_id_env or 'AWS_ACCESS_KEY_ID'} / "
                f"{spec.aws_secret_access_key_env or 'AWS_SECRET_ACCESS_KEY'}, "
                f"region={spec.region or '<unset>'})"
            )
        return False, f"no API key resolved (expected env {spec.api_key_env or 'OPENROUTER_API_KEY'})"

    if spec.route == "bedrock":
        return await _verify_bedrock(spec)

    if spec.route == "anthropic":
        # Anthropic authenticates with x-api-key, not a bearer token.
        headers = {"x-api-key": spec.api_key, "anthropic-version": ANTHROPIC_VERSION}
    else:
        headers = {"Authorization": f"Bearer {spec.api_key}"}
    if spec.route == "openrouter":
        url = f"{spec.base_url}/auth/key"
    else:
        url = f"{spec.base_url}/models"

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(url, headers=headers)
    except httpx.RequestError as exc:
        return False, f"{type(exc).__name__}: could not reach {spec.base_url}"

    if r.status_code == 200:
        return True, "verified"
    if r.status_code in (401, 403):
        return False, f"key rejected (HTTP {r.status_code})"
    return False, f"unexpected response (HTTP {r.status_code})"


async def _verify_bedrock(spec: ModelSpec) -> tuple[bool, str]:
    """Bedrock's control-plane `get_foundation_model` (not `bedrock-runtime`)
    is a metadata read -- zero inference cost -- and it confirms both that
    the credentials work and that this exact model id is real and
    accessible in this account/region, which is a strictly better check
    than any other provider here gets (they can only confirm the key works,
    not that the model itself exists)."""
    def _call():
        import boto3
        client = boto3.client(
            "bedrock",
            region_name=spec.region,
            aws_access_key_id=spec.aws_access_key_id,
            aws_secret_access_key=spec.aws_secret_access_key,
            aws_session_token=spec.aws_session_token or None,
        )
        client.get_foundation_model(modelIdentifier=spec.model)

    try:
        await asyncio.to_thread(_call)
        return True, "verified"
    except Exception as exc:
        error = getattr(exc, "response", None)
        error = error.get("Error", {}) if isinstance(error, dict) else {}
        code = error.get("Code") or type(exc).__name__
        message = error.get("Message") or str(exc)
        return False, f"{code}: {message}"[:300]
