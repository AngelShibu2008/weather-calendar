"""Request dependencies.

Auth is a development placeholder: the client sends `X-User-Id` (any stable string, e.g. the
auth provider's subject) and the user is created on first sight. Replace `current_user` with
real token verification (Firebase, Auth0, Supabase, …) before deploying.
"""

from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .db import get_db
from .models import User

DB = Annotated[Session, Depends(get_db)]


def valid_timezone(name: str) -> bool:
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


def current_user(
    db: DB,
    x_user_id: Annotated[str | None, Header()] = None,
    x_user_timezone: Annotated[str | None, Header()] = None,
) -> User:
    if not x_user_id:
        raise HTTPException(401, "Missing X-User-Id header")
    user = db.scalar(select(User).where(User.auth_subject == x_user_id))
    if user is None:
        tz = x_user_timezone if x_user_timezone and valid_timezone(x_user_timezone) else "UTC"
        user = User(auth_subject=x_user_id, timezone=tz)
        db.add(user)
        try:
            db.commit()
        except IntegrityError:  # a parallel first request created the user
            db.rollback()
            user = db.scalar(select(User).where(User.auth_subject == x_user_id))
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def owned(obj, user: User, what: str):
    """404 unless `obj` exists and belongs to `user`."""
    if obj is None or obj.user_id != user.id:
        raise HTTPException(404, f"{what} not found")
    return obj
