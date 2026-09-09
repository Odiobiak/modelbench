from __future__ import annotations

from collections.abc import AsyncGenerator
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from . import config

# Supabase's pooler (Supavisor) connection string carries a `pgbouncer=true`
# query param meant for Prisma's driver -- asyncpg doesn't recognize it and
# passes it through as a bogus kwarg to its connect() call, which raises
# TypeError. It's informational only for us (it just says "this is a
# transaction-mode pgbouncer-style pooler"), so it's dropped, not translated.
_STRIP_QUERY_PARAMS = {"pgbouncer"}


def _asyncpg_url(url: str) -> str:
    """Supabase hands out a plain `postgresql://` string; SQLAlchemy's async
    engine needs the asyncpg dialect prefix, and asyncpg can't take arbitrary
    query params passed straight through to its connect()."""
    if url.startswith("postgresql://"):
        url = "postgresql+asyncpg://" + url[len("postgresql://"):]

    parts = urlsplit(url)
    if parts.query:
        kept = [kv for kv in parts.query.split("&")
                if kv.split("=", 1)[0] not in _STRIP_QUERY_PARAMS]
        parts = parts._replace(query="&".join(kept))
    return urlunsplit(parts)


class Base(DeclarativeBase):
    pass


if not config.DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Add it to .env -- Supabase project "
        "> Settings > Database > Connection string (URI, use the pooler "
        "connection for serverless-friendly pooling)."
    )

engine = create_async_engine(
    _asyncpg_url(config.DATABASE_URL),
    pool_pre_ping=True,
    # Supavisor's transaction-mode pooler can hand different physical backend
    # connections to consecutive statements in the same logical connection,
    # which invalidates server-side prepared statement caching -- disable it
    # so asyncpg re-sends plain queries instead of relying on a stale plan.
    connect_args={"statement_cache_size": 0},
)
async_session_maker = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session
