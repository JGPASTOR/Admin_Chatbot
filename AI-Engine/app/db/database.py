"""SQLAlchemy database engine and session factory."""

from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from app.config import settings

engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,       # drop & recycle dead connections before use
    # Phase 3 — pool tuned for 4 Uvicorn workers @ 1,000 concurrent users
    # pool_size=20  → 20 persistent connections always open (5 per worker)
    # max_overflow=10 → up to 10 burst connections when pool is saturated
    # pool_timeout=30 → raise error after 30 s of waiting for a connection
    # pool_recycle=1800 → replace connections every 30 min (avoids MySQL wait_timeout)
    pool_size=20,
    max_overflow=10,
    pool_timeout=30,
    pool_recycle=1800,
    echo=False,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Type alias used in route function signatures: `db: DBSession = Depends(get_db)`
DBSession = Session


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
