"""Recurring payments: licenses, KLO, servers, AI subscriptions, VDS —
anything that has to be paid on a cadence and needs a heads-up before it's
due. Team-visible (unlike the private per-user Purchase vault) and drives
the admin payment-due reminder cron (see app.main.payment_due_reminder_job).
"""
import calendar
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional

from app.db.session import get_db
from app.models.models import RecurringPayment, Team, User
from app.core.security import get_current_user, require_admin, require_delete_token
from app.core.crypto import encrypt_secret, decrypt_secret

router = APIRouter(prefix="/api/payments", tags=["payments"])


def _add_months(dt: datetime, months: int) -> datetime:
    """Add N months to dt, clamping the day if the target month is shorter
    (e.g. Jan 31 + 1mo -> Feb 28/29). No dateutil dependency needed for this."""
    total = dt.month - 1 + months
    year = dt.year + total // 12
    month = total % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


class PaymentOut(BaseModel):
    id: int
    category: str
    label: str
    provider: Optional[str] = None
    team_id: Optional[int] = None
    team_name: Optional[str] = None
    login: Optional[str] = None
    password: Optional[str] = None
    cost_amount: Optional[str] = None
    cost_currency: Optional[str] = None
    billing_period_months: int
    next_due_at: Optional[datetime] = None
    last_paid_at: Optional[datetime] = None
    notes: Optional[str] = None
    created_by_username: Optional[str] = None
    created_at: Optional[datetime] = None
    class Config:
        from_attributes = True


class PaymentIn(BaseModel):
    category: str
    label: str
    provider: Optional[str] = None
    team_id: Optional[int] = None
    login: Optional[str] = None
    password: Optional[str] = None
    cost_amount: Optional[str] = None
    cost_currency: Optional[str] = "USD"
    billing_period_months: int = 1
    next_due_at: Optional[datetime] = None
    notes: Optional[str] = None


class PaymentPatch(BaseModel):
    category: Optional[str] = None
    label: Optional[str] = None
    provider: Optional[str] = None
    team_id: Optional[int] = None
    login: Optional[str] = None
    password: Optional[str] = None
    cost_amount: Optional[str] = None
    cost_currency: Optional[str] = None
    billing_period_months: Optional[int] = None
    next_due_at: Optional[datetime] = None
    notes: Optional[str] = None


async def _to_out(p: RecurringPayment, db: AsyncSession) -> PaymentOut:
    out = PaymentOut.model_validate(p)
    if p.password_enc:
        try:
            out.password = decrypt_secret(p.password_enc)
        except Exception:
            out.password = None
    if p.team_id:
        team = await db.get(Team, p.team_id)
        out.team_name = team.name if team else None
    if p.created_by_user_id:
        u = await db.get(User, p.created_by_user_id)
        out.created_by_username = u.username if u else None
    return out


@router.get("", response_model=list[PaymentOut])
async def list_payments(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(RecurringPayment).order_by(RecurringPayment.next_due_at.asc().nulls_last()))
    return [await _to_out(p, db) for p in result.scalars().all()]


@router.post("", response_model=PaymentOut, dependencies=[Depends(require_admin)])
async def create_payment(data: PaymentIn, db: AsyncSession = Depends(get_db),
                          user: User = Depends(get_current_user)):
    payload = data.model_dump(exclude={"password"})
    payment = RecurringPayment(**payload, created_by_user_id=user.id)
    if data.password:
        payment.password_enc = encrypt_secret(data.password)
    db.add(payment)
    await db.flush()
    await db.refresh(payment)
    return await _to_out(payment, db)


@router.patch("/{payment_id}", response_model=PaymentOut, dependencies=[Depends(require_admin)])
async def update_payment(payment_id: int, data: PaymentPatch, db: AsyncSession = Depends(get_db)):
    payment = await db.get(RecurringPayment, payment_id)
    if not payment:
        raise HTTPException(404, "Payment not found")
    updates = data.model_dump(exclude_unset=True, exclude={"password"})
    for k, v in updates.items():
        setattr(payment, k, v)
    if data.password is not None:
        payment.password_enc = encrypt_secret(data.password) if data.password else None
    await db.flush()
    await db.refresh(payment)
    await db.commit()
    return await _to_out(payment, db)


@router.post("/{payment_id}/mark-paid", response_model=PaymentOut, dependencies=[Depends(require_admin)])
async def mark_paid(payment_id: int, db: AsyncSession = Depends(get_db)):
    """Roll the due date forward by one billing period from whichever is
    later — the old due date or now — so paying late doesn't shortchange
    the next cycle, and paying early doesn't lose the remainder of this one."""
    payment = await db.get(RecurringPayment, payment_id)
    if not payment:
        raise HTTPException(404, "Payment not found")
    now = datetime.now(timezone.utc)
    base = payment.next_due_at if (payment.next_due_at and payment.next_due_at > now) else now
    payment.last_paid_at = now
    payment.next_due_at = _add_months(base, payment.billing_period_months)
    await db.flush()
    await db.refresh(payment)
    await db.commit()
    return await _to_out(payment, db)


@router.delete("/{payment_id}", dependencies=[Depends(require_delete_token)])
async def delete_payment(payment_id: int, db: AsyncSession = Depends(get_db)):
    payment = await db.get(RecurringPayment, payment_id)
    if not payment:
        raise HTTPException(404, "Payment not found")
    await db.delete(payment)
    return {"ok": True}
