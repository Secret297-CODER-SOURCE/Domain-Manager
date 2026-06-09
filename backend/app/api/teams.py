from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
from app.db.session import get_db
from app.models.models import Team, CloudflareAccount, KeitaroInstance
from app.core.security import require_admin, get_current_user, require_delete_token
from app.services.cloudflare.cf_zones import verify_account

router = APIRouter(prefix="/api/teams", tags=["teams"])

class TeamCreate(BaseModel):
    name: str
    description: Optional[str] = None

class TeamOut(BaseModel):
    id: int
    name: str
    description: Optional[str]
    class Config:
        from_attributes = True

class CFAccountCreate(BaseModel):
    name: str
    api_key: str
    email: Optional[str] = None

class CFAccountOut(BaseModel):
    id: int
    team_id: int
    name: str
    account_id: Optional[str]
    email: Optional[str]
    is_active: bool
    class Config:
        from_attributes = True

class KTInstanceCreate(BaseModel):
    name: str
    url: str
    api_key: str
    cname: Optional[str] = None

class CFAccountUpdate(BaseModel):
    name: Optional[str] = None
    api_key: Optional[str] = None
    email: Optional[str] = None

class KTInstanceUpdate(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    api_key: Optional[str] = None
    cname: Optional[str] = None

class KTInstanceOut(BaseModel):
    id: int
    team_id: int
    name: str
    url: str
    cname: Optional[str]
    is_active: bool
    class Config:
        from_attributes = True

@router.get("/cf-accounts-all", response_model=list[CFAccountOut])
async def list_all_cf_accounts(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(CloudflareAccount).order_by(CloudflareAccount.name))
    return result.scalars().all()


@router.get("", response_model=list[TeamOut])
async def list_teams(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(Team).order_by(Team.name))
    return result.scalars().all()

@router.post("", response_model=TeamOut, dependencies=[Depends(require_admin)])
async def create_team(data: TeamCreate, db: AsyncSession = Depends(get_db)):
    team = Team(name=data.name, description=data.description)
    db.add(team)
    await db.flush()
    await db.refresh(team)
    return team

class TeamUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None

@router.patch("/{team_id}", response_model=TeamOut, dependencies=[Depends(require_admin)])
async def update_team(team_id: int, data: TeamUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Team).where(Team.id == team_id))
    team = result.scalar_one_or_none()
    if not team:
        raise HTTPException(404, "Team not found")
    if data.name is not None and data.name.strip():
        team.name = data.name.strip()
    if data.description is not None:
        team.description = data.description.strip() or None
    await db.flush()
    await db.refresh(team)
    await db.commit()
    return team

@router.delete("/{team_id}", dependencies=[Depends(require_delete_token)])
async def delete_team(team_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Team).where(Team.id == team_id))
    team = result.scalar_one_or_none()
    if not team:
        raise HTTPException(404, "Team not found")
    await db.delete(team)
    return {"ok": True}

@router.get("/{team_id}/cf-accounts", response_model=list[CFAccountOut])
async def list_cf_accounts(team_id: int, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(CloudflareAccount).where(CloudflareAccount.team_id == team_id))
    return result.scalars().all()

@router.post("/{team_id}/cf-accounts", response_model=CFAccountOut, dependencies=[Depends(require_admin)])
async def add_cf_account(team_id: int, data: CFAccountCreate, db: AsyncSession = Depends(get_db)):
    team = await db.get(Team, team_id)
    if not team:
        raise HTTPException(404, "Team not found")
    # Try to resolve account_id — but don't block if token has limited permissions
    is_valid, acc_id = await verify_account(data.email, data.api_key)
    account = CloudflareAccount(
        team_id=team_id, name=data.name, api_key=data.api_key,
        email=data.email,
        account_id=acc_id if is_valid else None,
        is_active=True,  # always add as active; sync will mark inactive if truly invalid
    )
    db.add(account)
    await db.flush()
    await db.refresh(account)
    return account

@router.patch("/{team_id}/cf-accounts/{account_id}", response_model=CFAccountOut, dependencies=[Depends(require_admin)])
async def update_cf_account(team_id: int, account_id: int, data: CFAccountUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(CloudflareAccount).where(CloudflareAccount.id == account_id, CloudflareAccount.team_id == team_id))
    acc = result.scalar_one_or_none()
    if not acc:
        raise HTTPException(404, "Account not found")
    if data.name is not None:
        acc.name = data.name.strip()
    if data.email is not None:
        acc.email = data.email.strip() or None
    if data.api_key is not None and data.api_key.strip():
        new_key = data.api_key.strip()
        email = data.email.strip() if data.email is not None else acc.email
        is_valid, acc_id = await verify_account(email, new_key)
        acc.api_key = new_key
        acc.account_id = acc_id if is_valid else acc.account_id
        acc.is_active = True  # reset to active; sync will re-check
    await db.flush()
    await db.refresh(acc)
    await db.commit()
    return acc

@router.delete("/{team_id}/cf-accounts/{account_id}", dependencies=[Depends(require_delete_token)])
async def delete_cf_account(team_id: int, account_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(CloudflareAccount).where(CloudflareAccount.id == account_id, CloudflareAccount.team_id == team_id))
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(404, "Account not found")
    await db.delete(account)
    return {"ok": True}

@router.get("/{team_id}/kt-instances", response_model=list[KTInstanceOut])
async def list_kt_instances(team_id: int, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(KeitaroInstance).where(KeitaroInstance.team_id == team_id))
    return result.scalars().all()

@router.post("/{team_id}/kt-instances", response_model=KTInstanceOut, dependencies=[Depends(require_admin)])
async def add_kt_instance(team_id: int, data: KTInstanceCreate, db: AsyncSession = Depends(get_db)):
    team = await db.get(Team, team_id)
    if not team:
        raise HTTPException(404, "Team not found")
    instance = KeitaroInstance(team_id=team_id, name=data.name, url=data.url.rstrip("/"), api_key=data.api_key, cname=data.cname)
    db.add(instance)
    await db.flush()
    await db.refresh(instance)
    return instance

@router.patch("/{team_id}/kt-instances/{instance_id}", response_model=KTInstanceOut, dependencies=[Depends(require_admin)])
async def update_kt_instance(team_id: int, instance_id: int, data: KTInstanceUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(KeitaroInstance).where(KeitaroInstance.id == instance_id, KeitaroInstance.team_id == team_id))
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(404, "Instance not found")
    if data.name is not None:
        inst.name = data.name.strip()
    if data.url is not None:
        inst.url = data.url.rstrip("/")
    if data.api_key is not None and data.api_key.strip():
        inst.api_key = data.api_key.strip()
    if data.cname is not None:
        inst.cname = data.cname.strip() or None
    await db.flush()
    await db.refresh(inst)
    await db.commit()
    return inst

@router.delete("/{team_id}/kt-instances/{instance_id}", dependencies=[Depends(require_delete_token)])
async def delete_kt_instance(team_id: int, instance_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(KeitaroInstance).where(KeitaroInstance.id == instance_id, KeitaroInstance.team_id == team_id))
    inst = result.scalar_one_or_none()
    if not inst:
        raise HTTPException(404, "Instance not found")
    await db.delete(inst)
    return {"ok": True}
