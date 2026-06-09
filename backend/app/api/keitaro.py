from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
from app.db.session import get_db
from app.models.models import KeitaroInstance, KeitaroDomainGroup, Domain, Team, CloudflareAccount
from app.core.security import get_current_user, require_admin, require_delete_token
from app.services.keitaro.kt_sync import sync_groups, sync_all_instances
from app.services.keitaro.kt_add import add_domain_to_group
from app.services.keitaro.kt_move import move_to_group, move_to_instance
from app.services.keitaro.kt_delete import delete_from_keitaro

import httpx

router = APIRouter(prefix="/api/keitaro", tags=["keitaro"])


class GroupOut(BaseModel):
    id: int
    kt_group_id: str
    name: str
    keitaro_instance_id: int
    instance_name: Optional[str] = None
    team_name: Optional[str] = None
    class Config:
        from_attributes = True


class AddDomainReq(BaseModel):
    domain_id: int
    kt_instance_id: int
    kt_group_id: int


class MoveGroupReq(BaseModel):
    domain_id: int
    new_kt_group_id: int


class MoveInstanceReq(BaseModel):
    domain_id: int
    new_kt_instance_id: int
    new_kt_group_id: int
    new_cname_target: str  # CNAME value to set on CF pointing to new KT


class KTDomainItem(BaseModel):
    kt_domain_id: int
    domain: str
    group_id: Optional[int]
    group_name: Optional[str]
    instance_id: int
    instance_name: str
    team_name: str
    in_cf: bool
    cf_domain_id: Optional[int] = None
    cf_status: Optional[str] = None
    cf_account_name: Optional[str] = None


class KTOnlyDomain(BaseModel):
    kt_domain_id: int
    domain: str
    group_id: Optional[int]
    group_name: Optional[str]
    instance_id: int
    instance_name: str
    team_name: str


# ── Instances (all) ───────────────────────────────────────────────────────

class InstanceOut(BaseModel):
    id: int
    name: str
    team_name: str
    class Config:
        from_attributes = True

@router.get("/instances", response_model=list[InstanceOut])
async def list_all_instances(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(
        select(KeitaroInstance, Team)
        .join(Team, KeitaroInstance.team_id == Team.id)
        .where(KeitaroInstance.is_active == True)
        .order_by(Team.name, KeitaroInstance.name)
    )
    out = []
    for inst, team in result.all():
        out.append(InstanceOut(id=inst.id, name=inst.name, team_name=team.name))
    return out


# ── Full hierarchy: Instance → Group → Domains (from DB) ──────────────────

@router.get("/tree")
async def get_kt_tree(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Returns full KT hierarchy from DB: instances → groups → domains."""
    # All instances with team
    inst_rows = (await db.execute(
        select(KeitaroInstance, Team)
        .join(Team, KeitaroInstance.team_id == Team.id)
        .where(KeitaroInstance.is_active == True)
        .order_by(Team.name, KeitaroInstance.name)
    )).all()

    # All groups
    grp_rows = (await db.execute(
        select(KeitaroDomainGroup).order_by(KeitaroDomainGroup.name)
    )).scalars().all()
    groups_by_inst = {}
    for g in grp_rows:
        groups_by_inst.setdefault(g.keitaro_instance_id, []).append(g)

    # All domains with KT group
    dom_rows = (await db.execute(
        select(Domain)
        .where(Domain.keitaro_group_id.isnot(None))
        .order_by(Domain.name)
    )).scalars().all()
    domains_by_group = {}
    for d in dom_rows:
        domains_by_group.setdefault(d.keitaro_group_id, []).append(d.name)

    # Also domains with KT instance but no group (direct)
    no_group_rows = (await db.execute(
        select(Domain, KeitaroInstance)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
        .outerjoin(KeitaroInstance, KeitaroInstance.team_id == CloudflareAccount.team_id)
        .where(Domain.keitaro_group_id.is_(None))
        .where(Domain.direct_to_keitaro == True)
    )).all()

    tree = []
    for inst, team in inst_rows:
        groups = groups_by_inst.get(inst.id, [])
        group_list = []
        for g in groups:
            doms = domains_by_group.get(g.id, [])
            group_list.append({
                "id": g.id,
                "name": g.name,
                "kt_group_id": g.kt_group_id,
                "domain_count": len(doms),
                "domains": doms,
            })
        tree.append({
            "id": inst.id,
            "name": inst.name,
            "team": team.name,
            "group_count": len(groups),
            "domain_count": sum(len(domains_by_group.get(g.id, [])) for g in groups),
            "groups": group_list,
        })
    return tree


# ── Groups ────────────────────────────────────────────────────────────────

@router.get("/groups", response_model=list[GroupOut])
async def list_all_groups(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(
        select(KeitaroDomainGroup, KeitaroInstance, Team)
        .join(KeitaroInstance, KeitaroDomainGroup.keitaro_instance_id == KeitaroInstance.id)
        .join(Team, KeitaroInstance.team_id == Team.id)
        .order_by(Team.name, KeitaroInstance.name, KeitaroDomainGroup.name)
    )
    out = []
    for grp, inst, team in result.all():
        g = GroupOut.model_validate(grp)
        g.instance_name = inst.name
        g.team_name = team.name
        out.append(g)
    return out


@router.get("/groups/by-instance/{instance_id}", response_model=list[GroupOut])
async def groups_by_instance(instance_id: int, db: AsyncSession = Depends(get_db),
                             _=Depends(get_current_user)):
    result = await db.execute(
        select(KeitaroDomainGroup)
        .where(KeitaroDomainGroup.keitaro_instance_id == instance_id)
        .order_by(KeitaroDomainGroup.name)
    )
    return result.scalars().all()


@router.post("/groups/sync/{instance_id}", dependencies=[Depends(require_admin)])
async def sync_instance_groups(instance_id: int, db: AsyncSession = Depends(get_db)):
    inst = await db.get(KeitaroInstance, instance_id)
    if not inst:
        raise HTTPException(404, "KT instance not found")
    count = await sync_groups(inst, db)
    await db.commit()
    return {"ok": True, "synced": count, "instance": inst.name}


@router.post("/groups/sync-all", dependencies=[Depends(require_admin)])
async def sync_all_groups(db: AsyncSession = Depends(get_db)):
    result = await sync_all_instances(db)
    await db.commit()
    return {"ok": True, **result}


# ── Domain actions ─────────────────────────────────────────────────────────

@router.post("/domain/add", dependencies=[Depends(require_admin)])
async def add_to_kt(data: AddDomainReq, db: AsyncSession = Depends(get_db),
                    current_user=Depends(require_admin)):
    domain = await db.get(Domain, data.domain_id)
    if not domain:
        raise HTTPException(404, "Domain not found")
    inst = await db.get(KeitaroInstance, data.kt_instance_id)
    if not inst:
        raise HTTPException(404, "KT instance not found")
    group = await db.get(KeitaroDomainGroup, data.kt_group_id)
    if not group:
        raise HTTPException(404, "KT group not found")
    result = await add_domain_to_group(domain, inst, group, db, current_user.username)
    await db.commit()
    return result


@router.post("/domain/move-group", dependencies=[Depends(require_admin)])
async def move_domain_group(data: MoveGroupReq, db: AsyncSession = Depends(get_db),
                             current_user=Depends(require_admin)):
    domain = await db.get(Domain, data.domain_id)
    if not domain:
        raise HTTPException(404, "Domain not found")
    new_group = await db.get(KeitaroDomainGroup, data.new_kt_group_id)
    if not new_group:
        raise HTTPException(404, "New KT group not found")
    result = await move_to_group(domain, new_group, db, current_user.username)
    await db.commit()
    return result


@router.post("/domain/move-instance", dependencies=[Depends(require_admin)])
async def move_domain_instance(data: MoveInstanceReq, db: AsyncSession = Depends(get_db),
                                current_user=Depends(require_admin)):
    domain = await db.get(Domain, data.domain_id)
    if not domain:
        raise HTTPException(404, "Domain not found")
    new_inst = await db.get(KeitaroInstance, data.new_kt_instance_id)
    if not new_inst:
        raise HTTPException(404, "New KT instance not found")
    new_group = await db.get(KeitaroDomainGroup, data.new_kt_group_id)
    if not new_group:
        raise HTTPException(404, "New KT group not found")
    result = await move_to_instance(
        domain, new_inst, new_group, data.new_cname_target, db, current_user.username
    )
    await db.commit()
    return result


@router.delete("/domain/{domain_id}", dependencies=[Depends(require_delete_token)])
async def delete_domain_kt(domain_id: int, db: AsyncSession = Depends(get_db),
                            current_user=Depends(require_admin)):
    domain = await db.get(Domain, domain_id)
    if not domain:
        raise HTTPException(404, "Domain not found")
    result = await delete_from_keitaro(domain, db, current_user.username)
    await db.commit()
    return result


# ── All KT domains (live from KT API) ────────────────────────────────────

import logging as _logging
_kt_logger = _logging.getLogger("kt_domains")

@router.get("/domains", response_model=list[KTDomainItem])
async def list_kt_domains(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    our_result = await db.execute(
        select(Domain.id, Domain.name, Domain.zone_status, CloudflareAccount.name)
        .join(CloudflareAccount, Domain.cf_account_id == CloudflareAccount.id)
    )
    our_map = {row[1].lower(): {"id": row[0], "status": row[2].value, "cf_name": row[3]} for row in our_result.all()}

    inst_result = await db.execute(
        select(KeitaroInstance, Team)
        .join(Team, KeitaroInstance.team_id == Team.id)
    )
    all_domains = []
    for inst, team in inst_result.all():
        try:
            headers = {"Api-Key": inst.api_key, "Content-Type": "application/json"}
            base = f"{inst.url.rstrip('/')}/admin_api/v1"
            _kt_logger.info(f"[kt_domains] Fetching from {inst.name} → {base}/domains")
            async with httpx.AsyncClient(timeout=20, verify=False) as client:
                r = await client.get(f"{base}/domains", headers=headers)
            _kt_logger.info(f"[kt_domains] {inst.name} → HTTP {r.status_code}")
            if r.status_code != 200:
                _kt_logger.warning(f"[kt_domains] {inst.name} returned {r.status_code}: {r.text[:200]}")
                continue
            for d in (r.json() if isinstance(r.json(), list) else []):
                dname = (d.get("name") or "").lower()
                if not dname:
                    continue
                cf = our_map.get(dname)
                all_domains.append(KTDomainItem(
                    kt_domain_id=d.get("id", 0),
                    domain=dname,
                    group_id=d.get("group_id"),
                    group_name=d.get("group") or None,
                    instance_id=inst.id,
                    instance_name=inst.name,
                    team_name=team.name,
                    in_cf=cf is not None,
                    cf_domain_id=cf["id"] if cf else None,
                    cf_status=cf["status"] if cf else None,
                    cf_account_name=cf["cf_name"] if cf else None,
                ))
        except Exception as e:
            _kt_logger.error(f"[kt_domains] {inst.name} exception: {e}")
            continue
    return all_domains


# ── Orphan domains (in KT but not in CF) ──────────────────────────────────

@router.get("/orphan-domains", response_model=list[KTOnlyDomain])
async def orphan_domains(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
    search: Optional[str] = Query(None),
):
    import httpx, asyncio
    our_result = await db.execute(select(Domain.name))
    our_names = {row[0].lower() for row in our_result.all()}

    inst_result = await db.execute(
        select(KeitaroInstance, Team)
        .join(Team, KeitaroInstance.team_id == Team.id)
        .where(KeitaroInstance.is_active == True)
    )
    instances = inst_result.all()
    search_lower = search.strip().lower() if search and search.strip() else None

    async def fetch_instance(inst, team):
        try:
            headers = {"Api-Key": inst.api_key, "Content-Type": "application/json"}
            base = f"{inst.url.rstrip('/')}/admin_api/v1"
            async with httpx.AsyncClient(timeout=20, verify=False) as client:
                rd = await client.get(f"{base}/domains", headers=headers)
            kt_domains = rd.json() if rd.status_code == 200 else []
            result = []
            for d in (kt_domains if isinstance(kt_domains, list) else []):
                dname = (d.get("name") or "").lower()
                if not dname or dname in our_names:
                    continue
                if search_lower and search_lower not in dname:
                    continue
                result.append(KTOnlyDomain(
                    kt_domain_id=d.get("id", 0),
                    domain=dname,
                    group_id=d.get("group_id"),
                    group_name=d.get("group") or "—",
                    instance_id=inst.id,
                    instance_name=inst.name,
                    team_name=team.name,
                ))
            return result
        except Exception:
            return []

    results = await asyncio.gather(*[fetch_instance(inst, team) for inst, team in instances])
    orphans = [item for sublist in results for item in sublist]
    return orphans


class BulkAddKTReq(BaseModel):
    domains: list[str]
    kt_instance_id: int
    kt_group_id: int


@router.post("/bulk-add", dependencies=[Depends(require_admin)])
async def bulk_add_to_kt(
    data: BulkAddKTReq, db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    names = [n.strip().lower() for n in data.domains if n.strip()]
    dom_result = await db.execute(select(Domain).where(Domain.name.in_(names)))
    domains = dom_result.scalars().all()

    instance = await db.get(KeitaroInstance, data.kt_instance_id)
    grp_result = await db.execute(
        select(KeitaroDomainGroup).where(
            KeitaroDomainGroup.id == data.kt_group_id,
            KeitaroDomainGroup.keitaro_instance_id == data.kt_instance_id,
        )
    )
    group = grp_result.scalar_one_or_none()
    if not instance or not group:
        raise HTTPException(404, "KT instance or group not found")

    results = []
    for domain in domains:
        res = await add_domain_to_group(domain, instance, group, db, user=current_user.username)
        results.append(res)

    await db.commit()
    return {"results": results}


# ── Bulk transfer to another KT instance ──────────────────────────────────

class BulkTransferReq(BaseModel):
    domains: list[str]           # domain names
    target_instance_id: int
    target_group_id: Optional[int] = None
    remove_from_old: bool = True  # delete from old KT
    update_cname: bool = True     # update CF CNAME to new instance


@router.post("/bulk-transfer", dependencies=[Depends(require_admin)])
async def bulk_transfer(
    data: BulkTransferReq,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    import asyncio
    from app.services.cloudflare.cf_dns import swap_main_record
    from app.services.cloudflare.cf_zones import make_headers

    target_inst = await db.get(KeitaroInstance, data.target_instance_id)
    if not target_inst:
        raise HTTPException(404, "Target KT instance not found")

    target_group = None
    if data.target_group_id:
        target_group = await db.get(KeitaroDomainGroup, data.target_group_id)

    # Fetch all domains from target KT once (to detect existing ones)
    existing_in_target: dict[str, int] = {}  # name → kt_domain_id
    try:
        async with httpx.AsyncClient(timeout=30, verify=False) as client:
            r = await client.get(
                f"{target_inst.url.rstrip('/')}/admin_api/v1/domains",
                headers={"Api-Key": target_inst.api_key, "Content-Type": "application/json"},
            )
        if r.status_code == 200:
            for d in (r.json() if isinstance(r.json(), list) else []):
                n = (d.get("name") or "").lower()
                if n:
                    existing_in_target[n] = d.get("id")
    except Exception as e:
        pass  # proceed without pre-check

    names = [n.strip().lower() for n in data.domains if n.strip()]
    dom_map = {}
    dom_result = await db.execute(select(Domain).where(Domain.name.in_(names)))
    for d in dom_result.scalars().all():
        dom_map[d.name] = d

    results = []

    for name in names:
        item = {"domain": name, "status": "error", "action": None, "detail": ""}
        domain = dom_map.get(name)

        try:
            base = f"{target_inst.url.rstrip('/')}/admin_api/v1"
            headers = {"Api-Key": target_inst.api_key, "Content-Type": "application/json"}
            group_id_kt = int(target_group.kt_group_id) if target_group else None

            if name in existing_in_target:
                # Domain already in target KT — move to group if specified
                kt_id = existing_in_target[name]
                if group_id_kt:
                    # Try PUT first, fallback to PATCH
                    ok_status = False
                    for method in ("put", "patch"):
                        async with httpx.AsyncClient(timeout=20, verify=False) as client:
                            fn = getattr(client, method)
                            pr = await fn(f"{base}/domains/{kt_id}", headers=headers,
                                         json={"group_id": group_id_kt})
                        if pr.status_code in (200, 201):
                            ok_status = True
                            break
                    item["action"] = "moved_group"
                    item["status"] = "ok" if ok_status else "error"
                    if not ok_status:
                        item["detail"] = str(pr.json())
                else:
                    item["action"] = "already_exists"
                    item["status"] = "ok"
            else:
                # Add to target KT
                payload = {"name": name}
                if group_id_kt:
                    payload["group_id"] = group_id_kt
                payload["https_only"] = True
                async with httpx.AsyncClient(timeout=20, verify=False) as client:
                    r = await client.post(f"{base}/domains", headers=headers, json=payload)
                if r.status_code == 422 and "https_only" in str(r.json()):
                    payload.pop("https_only")
                    async with httpx.AsyncClient(timeout=20, verify=False) as client:
                        r = await client.post(f"{base}/domains", headers=headers, json=payload)
                    # Try PATCH https_only
                    if r.status_code in (200, 201) and isinstance(r.json(), dict) and r.json().get("id"):
                        try:
                            async with httpx.AsyncClient(timeout=10, verify=False) as client:
                                await client.patch(f"{base}/domains/{r.json()['id']}", headers=headers, json={"https_only": True})
                        except Exception:
                            pass
                item["action"] = "added"
                item["status"] = "ok" if r.status_code in (200, 201) else "error"
                if r.status_code not in (200, 201):
                    item["detail"] = str(r.json())

            # Update CF CNAME if domain in our DB and target has cname
            if item["status"] == "ok" and domain and data.update_cname and target_inst.cname:
                cf_acc_result = await db.execute(
                    select(CloudflareAccount).where(CloudflareAccount.id == domain.cf_account_id)
                )
                cf_acc = cf_acc_result.scalar_one_or_none()
                if cf_acc:
                    dns_res = await swap_main_record(domain, cf_acc, "CNAME", target_inst.cname, True, db)
                    item["cname"] = dns_res.get("status")

            # Remove from old KT
            if item["status"] == "ok" and data.remove_from_old and domain and domain.keitaro_group_id:
                old_grp_result = await db.execute(
                    select(KeitaroDomainGroup).where(KeitaroDomainGroup.id == domain.keitaro_group_id)
                )
                old_grp = old_grp_result.scalar_one_or_none()
                if old_grp and old_grp.keitaro_instance_id != data.target_instance_id:
                    old_inst = await db.get(KeitaroInstance, old_grp.keitaro_instance_id)
                    if old_inst:
                        try:
                            old_headers = {"Api-Key": old_inst.api_key, "Content-Type": "application/json"}
                            old_base = f"{old_inst.url.rstrip('/')}/admin_api/v1"
                            async with httpx.AsyncClient(timeout=20, verify=False) as client:
                                sr = await client.get(f"{old_base}/domains", headers=old_headers)
                            old_id = next((d["id"] for d in (sr.json() if sr.status_code == 200 else [])
                                          if (d.get("name") or "").lower() == name), None)
                            if old_id:
                                async with httpx.AsyncClient(timeout=20, verify=False) as client:
                                    await client.delete(f"{old_base}/domains/{old_id}", headers=old_headers)
                        except Exception:
                            pass

            # Update DB
            if item["status"] == "ok" and domain:
                if target_group:
                    domain.keitaro_group_id = target_group.id
                db.add(ActionLog(
                    action="kt_move_instance",
                    user=current_user.username,
                    domain=name,
                    details=f"Transfer → {target_inst.name} / {target_group.name if target_group else 'без групи'} [{item['action']}]",
                ))
                await db.flush()

        except Exception as e:
            item["detail"] = str(e)

        results.append(item)

    await db.commit()
    ok = sum(1 for r in results if r["status"] == "ok")
    return {"results": results, "ok": ok, "total": len(results)}
