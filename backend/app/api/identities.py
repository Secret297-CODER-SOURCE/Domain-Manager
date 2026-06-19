from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from datetime import datetime, timezone
from typing import Optional
import asyncio
import random
import re
import secrets
import unicodedata
import httpx

from app.db.session import get_db
from app.models.models import Identity, User
from app.core.security import get_current_user
from app.services.identity_profiles import synth_for, PROFILES

router = APIRouter(prefix="/api/identities", tags=["identities"])

# UI list of locations. Internally we map each to randomuser.me's `nat` parameter
# where possible. Unsupported locations fall back to no-nat (random) but we
# still label the country code so the user sees what they picked.
LOCATIONS = [
    "ar", "au", "bd", "be", "br", "ca", "cn", "cz", "fr", "de", "gr", "hu",
    "in", "id", "ir", "it", "jp", "my", "mx", "nl", "ng", "pe", "ph", "pl",
    "pt", "ro", "ru", "sa", "sg", "za", "kr", "es", "se", "th", "tr", "ug",
    "ua", "uk", "us", "vn",
]

# randomuser.me supported nats
RANDOMUSER_NATS = {
    "au", "br", "ca", "ch", "de", "dk", "es", "fi", "fr", "gb", "ie", "in",
    "ir", "mx", "nl", "no", "nz", "rs", "tr", "ua", "us",
}
# Aliases (UI code → randomuser nat)
NAT_ALIAS = {"uk": "gb"}


class IdentityData(BaseModel):
    country_code: str
    full_name: Optional[str] = None
    gender: Optional[str] = None
    birthday: Optional[str] = None
    ssn: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    picture: Optional[str] = None
    card_brand: Optional[str] = None
    card_number: Optional[str] = None
    card_expire: Optional[str] = None
    card_cvv: Optional[str] = None
    street: Optional[str] = None
    city: Optional[str] = None
    region: Optional[str] = None
    zip_code: Optional[str] = None
    country_full: Optional[str] = None
    latitude: Optional[str] = None
    longitude: Optional[str] = None


class IdentityOut(IdentityData):
    id: int
    label: Optional[str] = None
    notes: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class SaveIdentityIn(IdentityData):
    label: Optional[str] = None
    notes: Optional[str] = None


# ── Credit card (Luhn-valid) ─────────────────────────────────────────────

CARD_BRANDS = [
    ("Visa",       ["4"],                               16),
    ("Mastercard", ["51", "52", "53", "54", "55"],      16),
    ("Mastercard", ["2221", "2222", "2720"],            16),
    ("Amex",       ["34", "37"],                        15),
    ("Discover",   ["6011", "65"],                      16),
]


def _luhn_checksum(digits: list[int]) -> int:
    """Returns the digit that makes the sequence valid."""
    s = 0
    parity = (len(digits) + 1) % 2
    for i, d in enumerate(digits):
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        s += d
    return (10 - s % 10) % 10


def generate_card() -> dict:
    brand, prefixes, length = random.choice(CARD_BRANDS)
    prefix = random.choice(prefixes)
    body = [int(c) for c in prefix]
    while len(body) < length - 1:
        body.append(secrets.randbelow(10))
    body.append(_luhn_checksum(body))
    number = "".join(str(d) for d in body)
    # Format with spaces for readability
    if length == 15:
        formatted = f"{number[:4]} {number[4:10]} {number[10:]}"
    else:
        formatted = " ".join(number[i:i+4] for i in range(0, length, 4))
    month = secrets.randbelow(12) + 1
    year = datetime.now().year + 1 + secrets.randbelow(5)
    return {
        "card_brand": brand,
        "card_number": formatted,
        "card_expire": f"{month:02d}/{str(year)[-2:]}",
        "card_cvv": f"{secrets.randbelow(9000) + 1000}" if brand == "Amex" else f"{secrets.randbelow(900) + 100}",
    }


# ── SSN / national ID per country ─────────────────────────────────────────

def generate_ssn(cc: str, given: Optional[str] = None) -> str:
    if given:
        return given
    cc = cc.lower()
    r = lambda n: "".join(str(secrets.randbelow(10)) for _ in range(n))
    if cc == "us":
        # SSN: NNN-NN-NNNN, avoid invalid ranges loosely (no 000, 666, 9XX area)
        a = secrets.randbelow(899) + 1
        if a == 666: a = 665
        return f"{a:03d}-{secrets.randbelow(99)+1:02d}-{secrets.randbelow(9999)+1:04d}"
    if cc == "ca":
        return f"{r(3)}-{r(3)}-{r(3)}"   # SIN format
    if cc == "ua":
        return r(10)                     # ІПН — 10 digits
    if cc in ("gb", "uk"):
        # NI: 2 letters + 6 digits + 1 letter A-D
        letters = "ABCEGHJKLMNOPRSTWXYZ"
        return f"{random.choice(letters)}{random.choice(letters)} {r(2)} {r(2)} {r(2)} {random.choice('ABCD')}"
    if cc == "de":
        return r(11)                     # Steuer-ID
    if cc == "fr":
        return f"{r(1)} {r(2)} {r(2)} {r(2)} {r(3)} {r(3)} {r(2)}"  # INSEE 15 digits grouped
    if cc in ("ru", "by"):
        return f"{r(3)}-{r(3)}-{r(3)} {r(2)}"   # СНИЛС format
    if cc == "jp":
        # My Number — 12 digits, often shown as 4-4-4
        return f"{r(4)} {r(4)} {r(4)}"
    if cc in ("in",):
        # Aadhaar — 12 digits, 4-4-4
        return f"{r(4)} {r(4)} {r(4)}"
    if cc == "cn":
        # ID card — 18 chars: 6 region + YYYYMMDD + 3 seq + 1 check (X allowed)
        from datetime import datetime
        year = 1960 + secrets.randbelow(45)
        month = secrets.randbelow(12) + 1
        day = secrets.randbelow(28) + 1
        return f"{r(6)}{year:04d}{month:02d}{day:02d}{r(3)}{random.choice('0123456789X')}"
    if cc == "ar":
        return r(8)                      # DNI 7-8 digits
    if cc in ("br",):
        return f"{r(3)}.{r(3)}.{r(3)}-{r(2)}"   # CPF
    if cc == "mx":
        # CURP-ish 18 chars
        letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        return f"{random.choice(letters)}{random.choice(letters)}{random.choice(letters)}{random.choice(letters)}{r(6)}{random.choice('HM')}{random.choice(letters)*2}{r(2)}"
    if cc == "es":
        # DNI: 8 digits + 1 letter
        n = r(8); letter = "TRWAGMYFPDXBNJZSQVHLCKE"[int(n) % 23]
        return f"{n}{letter}"
    if cc == "it":
        # Codice Fiscale — 16 alphanumeric
        ab = "".join(random.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ") for _ in range(6))
        return f"{ab}{r(2)}{random.choice('ABCDEHLMPRST')}{r(2)}{random.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZ')}{r(3)}{random.choice('ABCDEFGHIJKLMNOPQRSTUVWXYZ')}"
    if cc == "pl":
        return r(11)                     # PESEL
    if cc == "nl":
        return r(9)                      # BSN
    if cc == "se":
        return f"{r(6)}-{r(4)}"          # Personnummer YYMMDD-XXXX
    if cc == "kr":
        return f"{r(6)}-{r(7)}"          # RRN
    if cc == "tr":
        return r(11)                     # TC Kimlik
    if cc == "ro":
        return r(13)                     # CNP
    if cc in ("au", "nz"):
        return r(9)
    # Generic fallback: 9 digits
    return r(9)


# ── Helpers: ASCII slug + phone sanitize ─────────────────────────────────

def ascii_slug(text: Optional[str], default: str = "user") -> str:
    """Transliterate to ASCII (NFKD) → drop non-letters → lowercase. Falls back
    to `default` if nothing left after normalization (e.g. CJK name)."""
    if not text:
        return default
    norm = unicodedata.normalize("NFKD", text)
    ascii_only = norm.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^A-Za-z]+", "", ascii_only).lower()
    return slug[:24] or default


def sanitize_phone(raw: Optional[str], fallback_fmt: Optional[str] = None) -> Optional[str]:
    """randomuser.me sometimes returns letters in phone (notably for nat=ua,
    where digits 7-9 are replaced with random uppercase letters). Replace any
    embedded letter with a random digit so the value is dialable. If the input
    looks unusable and a country-specific fallback format is provided, generate
    a fresh number from the format."""
    if not raw:
        return None
    # Replace any A-Z / a-z with a random digit
    if re.search(r"[A-Za-z]", raw):
        cleaned = "".join(
            str(secrets.randbelow(10)) if ch.isalpha() else ch
            for ch in raw
        )
        return cleaned
    return raw


# ── randomuser.me fetch ──────────────────────────────────────────────────

async def fetch_one(code: str) -> IdentityData:
    if code == "random":
        code = random.choice(LOCATIONS)
    code = code.lower().strip()
    if code not in LOCATIONS:
        raise HTTPException(400, f"Unsupported locale '{code}'. Available: {LOCATIONS}")

    nat = NAT_ALIAS.get(code, code)
    # Pre-decide gender so that the photo (from randomuser) matches the name
    # we may overlay later for non-native locales.
    forced_gender = random.choice(("male", "female"))
    params = {"results": "1", "gender": forced_gender}
    if nat in RANDOMUSER_NATS:
        params["nat"] = nat

    headers = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 DomainManager/1.0",
    }
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as c:
            r = await c.get("https://randomuser.me/api/", params=params, headers=headers)
        if r.status_code != 200:
            raise HTTPException(502, f"randomuser.me HTTP {r.status_code}")
        payload = r.json()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"randomuser.me unreachable: {e}")

    if not payload.get("results"):
        raise HTTPException(502, "randomuser.me returned no results")
    u = payload["results"][0]

    name = u.get("name", {}) or {}
    loc = u.get("location", {}) or {}
    street = loc.get("street", {}) or {}
    coords = loc.get("coordinates", {}) or {}
    dob = u.get("dob", {}) or {}
    pid = u.get("id", {}) or {}
    login = u.get("login", {}) or {}
    picture = u.get("picture", {}) or {}

    full_name = " ".join(
        [name.get("title", "").strip(), name.get("first", "").strip(), name.get("last", "").strip()]
    ).strip()

    birthday = None
    if dob.get("date"):
        try:
            birthday = datetime.fromisoformat(dob["date"].replace("Z", "+00:00")).strftime("%Y-%m-%d")
        except Exception:
            birthday = (dob.get("date") or "")[:10]

    street_str = " ".join(filter(None, [str(street.get("number") or "").strip(), street.get("name") or ""])).strip() or None

    card = generate_card()
    given_ssn = pid.get("value") if pid.get("value") and pid.get("name") not in (None, "") else None

    base = IdentityData(
        country_code=code,
        full_name=full_name or None,
        gender=(u.get("gender") or "").capitalize() or None,
        birthday=birthday,
        ssn=generate_ssn(code, given_ssn),
        phone=sanitize_phone(u.get("phone") or u.get("cell")),
        email=u.get("email") or None,
        username=login.get("username") or None,
        password=login.get("password") or None,
        picture=picture.get("large") or picture.get("medium") or None,
        street=street_str,
        city=loc.get("city") or None,
        region=loc.get("state") or None,
        zip_code=str(loc.get("postcode") or "") or None,
        country_full=loc.get("country") or None,
        latitude=str(coords.get("latitude") or "") or None,
        longitude=str(coords.get("longitude") or "") or None,
        **card,
    )

    # Apply per-country overlay when:
    #   • randomuser doesn't natively support this nat (we got a random person, fix it), OR
    #   • we have a profile but randomuser's location/phone don't match (cleanup)
    #
    # The base from randomuser still keeps email/username/password/picture/birthday/card.
    overlay = synth_for(code, gender=forced_gender)
    if overlay and nat not in RANDOMUSER_NATS:
        # Country not native — replace name + all location/phone fields with country-correct ones
        for k, v in overlay.items():
            setattr(base, k, v)
        # Rebuild username & email so they match the new name (ASCII-safe).
        # Use the SAME numeric suffix for both so they look like a coherent pair.
        slug = ascii_slug(base.full_name, "user")
        suffix = secrets.randbelow(9000) + 1000
        base.username = f"{slug}{suffix}"
        base.email    = f"{slug}{suffix}@example.com"
        # SSN according to country format
        base.ssn = generate_ssn(code)
    elif overlay:
        # Native nat — keep randomuser data, but normalize country_full to avoid aliases
        base.country_full = overlay.get("country_full") or base.country_full
        # If username/email are missing OR contain non-ASCII garbage from randomuser, regenerate.
        if base.username and not base.username.isascii():
            base.username = f"{ascii_slug(base.full_name)}{secrets.randbelow(900) + 100}"
        if base.email and not base.email.isascii():
            base.email = f"{ascii_slug(base.full_name)}{secrets.randbelow(900) + 100}@example.com"

    return base


@router.get("/locations")
async def list_locations(_: User = Depends(get_current_user)):
    return {"locations": LOCATIONS}


@router.post("/generate", response_model=IdentityData)
async def generate(loc: str = Query("random"), _: User = Depends(get_current_user)):
    return await fetch_one(loc)


@router.post("/generate-bulk", response_model=list[IdentityData])
async def generate_bulk(
    loc: str = Query("random"),
    count: int = Query(5, ge=1, le=20),
    _: User = Depends(get_current_user),
):
    sem = asyncio.Semaphore(5)

    async def one():
        async with sem:
            return await fetch_one(loc)

    return await asyncio.gather(*[one() for _ in range(count)])


# ── Saved identities ─────────────────────────────────────────────────────

@router.get("/saved", response_model=list[IdentityOut])
async def list_saved(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Identity).where(Identity.owner_user_id == user.id).order_by(Identity.id.desc())
    return (await db.execute(q)).scalars().all()


@router.post("/saved", response_model=IdentityOut)
async def save_identity(data: SaveIdentityIn, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    obj = Identity(owner_user_id=user.id, **data.model_dump())
    db.add(obj)
    await db.flush()
    await db.refresh(obj)
    return obj


class IdentityPatch(BaseModel):
    label: Optional[str] = None
    notes: Optional[str] = None


@router.patch("/saved/{iid}", response_model=IdentityOut)
async def update_saved(iid: int, data: IdentityPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    obj = await db.get(Identity, iid)
    if not obj or obj.owner_user_id != user.id:
        raise HTTPException(404, "Not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(obj, k, v)
    await db.flush()
    await db.refresh(obj)
    return obj


@router.delete("/saved/{iid}")
async def delete_saved(iid: int, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    obj = await db.get(Identity, iid)
    if not obj or obj.owner_user_id != user.id:
        raise HTTPException(404, "Not found")
    await db.delete(obj)
    return {"ok": True}
