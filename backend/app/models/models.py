from sqlalchemy import (
    Column, String, Integer, Boolean, DateTime, Text, LargeBinary,
    ForeignKey, Enum as SAEnum, UniqueConstraint
)
from sqlalchemy.orm import relationship, DeclarativeBase
from sqlalchemy.sql import func
import enum


class Base(DeclarativeBase):
    pass


class UserRole(str, enum.Enum):
    admin = "admin"
    viewer = "viewer"


class DomainStatus(str, enum.Enum):
    active = "active"
    suspended = "suspended"
    pending = "pending"
    unknown = "unknown"


class RecordType(str, enum.Enum):
    A = "A"
    CNAME = "CNAME"
    MX = "MX"
    TXT = "TXT"
    NS = "NS"
    AAAA = "AAAA"


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    hashed_password = Column(String(256), nullable=False)
    role = Column(SAEnum(UserRole), default=UserRole.viewer, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Team(Base):
    __tablename__ = "teams"
    id = Column(Integer, primary_key=True)
    name = Column(String(128), unique=True, nullable=False, index=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    cloudflare_accounts = relationship("CloudflareAccount", back_populates="team", cascade="all, delete-orphan")
    keitaro_instances = relationship("KeitaroInstance", back_populates="team", cascade="all, delete-orphan")


class CloudflareAccount(Base):
    __tablename__ = "cloudflare_accounts"
    id = Column(Integer, primary_key=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(128), nullable=False)
    account_id = Column(String(64), nullable=True)
    email = Column(String(256), nullable=True)
    api_key = Column(Text, nullable=False)
    is_active = Column(Boolean, default=True)
    last_synced_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    team = relationship("Team", back_populates="cloudflare_accounts")
    domains = relationship("Domain", back_populates="cf_account", cascade="all, delete-orphan")
    __table_args__ = (UniqueConstraint("team_id", "name"),)


class KeitaroInstance(Base):
    __tablename__ = "keitaro_instances"
    id = Column(Integer, primary_key=True)
    team_id = Column(Integer, ForeignKey("teams.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(128), nullable=False)
    url = Column(String(512), nullable=False)
    api_key = Column(Text, nullable=False)
    cname = Column(String(512), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    team = relationship("Team", back_populates="keitaro_instances")
    domain_groups = relationship("KeitaroDomainGroup", back_populates="keitaro_instance")


class KeitaroDomainGroup(Base):
    __tablename__ = "keitaro_domain_groups"
    id = Column(Integer, primary_key=True)
    keitaro_instance_id = Column(Integer, ForeignKey("keitaro_instances.id", ondelete="CASCADE"), nullable=False)
    kt_group_id = Column(String(64), nullable=False)
    name = Column(String(256), nullable=False)
    synced_at = Column(DateTime(timezone=True), nullable=True)
    keitaro_instance = relationship("KeitaroInstance", back_populates="domain_groups")
    domains = relationship("Domain", back_populates="keitaro_group")
    __table_args__ = (UniqueConstraint("keitaro_instance_id", "kt_group_id"),)


class Domain(Base):
    __tablename__ = "domains"
    id = Column(Integer, primary_key=True)
    cf_account_id = Column(Integer, ForeignKey("cloudflare_accounts.id", ondelete="CASCADE"), nullable=False)
    zone_id = Column(String(64), nullable=False, unique=True, index=True)
    name = Column(String(256), nullable=False, index=True)
    zone_status = Column(SAEnum(DomainStatus), default=DomainStatus.unknown)
    registered_at = Column(DateTime(timezone=True), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    main_record_type = Column(SAEnum(RecordType), nullable=True)
    main_record_value = Column(String(512), nullable=True)
    direct_to_keitaro = Column(Boolean, default=False)  # A record pointing directly to KT IP
    keitaro_group_id = Column(Integer, ForeignKey("keitaro_domain_groups.id", ondelete="SET NULL"), nullable=True)
    notes = Column(Text, nullable=True)
    name_servers = Column(String(512), nullable=True)  # comma-separated NS, e.g. "ada.ns.cf.com,bob.ns.cf.com"
    last_checked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    cf_account = relationship("CloudflareAccount", back_populates="domains")
    keitaro_group = relationship("KeitaroDomainGroup", back_populates="domains")
    dns_records = relationship("DnsRecord", back_populates="domain", cascade="all, delete-orphan")


class DnsRecord(Base):
    __tablename__ = "dns_records"
    id = Column(Integer, primary_key=True)
    domain_id = Column(Integer, ForeignKey("domains.id", ondelete="CASCADE"), nullable=False)
    cf_record_id = Column(String(64), nullable=True)
    record_type = Column(SAEnum(RecordType), nullable=False)
    name = Column(String(256), nullable=False)
    value = Column(String(512), nullable=False)
    ttl = Column(Integer, default=1)
    proxied = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    domain = relationship("Domain", back_populates="dns_records")


class AbuseAlert(Base):
    __tablename__ = "abuse_alerts"
    id = Column(Integer, primary_key=True)
    domain_id = Column(Integer, ForeignKey("domains.id", ondelete="CASCADE"), nullable=False)
    previous_status = Column(SAEnum(DomainStatus))
    new_status = Column(SAEnum(DomainStatus))
    tg_message_id = Column(Integer, nullable=True)
    resolved = Column(Boolean, default=False)
    dns_deleted = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ActionLog(Base):
    """Log of all actions — kept for 7 days."""
    __tablename__ = "action_logs"
    id = Column(Integer, primary_key=True)
    action = Column(String(64), nullable=False, index=True)
    user = Column(String(64), nullable=True, default="system")
    domain = Column(String(256), nullable=True, index=True)
    details = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class Spreadsheet(Base):
    """Editable spreadsheet doc. data = JSON serialized fortune-sheet workbook."""
    __tablename__ = "spreadsheets"
    id = Column(Integer, primary_key=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(256), nullable=False)
    data = Column(Text, nullable=False, default="[]")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())


class KeepassVault(Base):
    """Encrypted .kdbx blob owned by an admin. Decryption happens in the browser."""
    __tablename__ = "keepass_vaults"
    id = Column(Integer, primary_key=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(256), nullable=False)
    blob = Column(LargeBinary, nullable=False)
    size_bytes = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())


class KeepassShare(Base):
    """Sharee user gets read/edit access to a vault. They must know the master password (shared out of band)."""
    __tablename__ = "keepass_shares"
    id = Column(Integer, primary_key=True)
    vault_id = Column(Integer, ForeignKey("keepass_vaults.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    can_edit = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("vault_id", "user_id"),)


class Proxy(Base):
    __tablename__ = "proxies"
    id = Column(Integer, primary_key=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    label = Column(String(128), nullable=True)
    type = Column(String(16), nullable=False, default="http")  # http | https | socks5
    host = Column(String(256), nullable=False)
    port = Column(Integer, nullable=False)
    username = Column(String(128), nullable=True)
    password = Column(String(256), nullable=True)
    country = Column(String(8), nullable=True)
    tags = Column(String(256), nullable=True)  # comma-separated
    notes = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    last_check_at = Column(DateTime(timezone=True), nullable=True)
    last_check_ok = Column(Boolean, nullable=True)
    last_check_ip = Column(String(64), nullable=True)
    last_check_latency_ms = Column(Integer, nullable=True)
    last_check_error = Column(String(512), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class Purchase(Base):
    """Generic purchase record: accounts, servers, domains, software, etc."""
    __tablename__ = "purchases"
    id = Column(Integer, primary_key=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    category = Column(String(32), nullable=False, default="account")  # account|server|domain|software|other
    label = Column(String(256), nullable=False)
    provider = Column(String(128), nullable=True)
    login = Column(String(256), nullable=True)
    password = Column(String(512), nullable=True)  # stored plain (private per-user). Use KeePass for high-sec.
    url = Column(String(512), nullable=True)
    cost_amount = Column(String(32), nullable=True)  # store as string to allow "12.34" without float drift
    cost_currency = Column(String(8), nullable=True, default="USD")
    purchased_at = Column(DateTime(timezone=True), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(16), nullable=False, default="active")  # active|expired|cancelled
    tags = Column(String(256), nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class KumaInstance(Base):
    """User-defined Uptime Kuma dashboard. Embedded via iframe in the UI."""
    __tablename__ = "kuma_instances"
    id = Column(Integer, primary_key=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(128), nullable=False)
    url = Column(String(512), nullable=False)
    color = Column(String(16), nullable=True)  # hex like #0a84ff
    sort_order = Column(Integer, nullable=False, default=0)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class BackupConfig(Base):
    """Singleton row (id=1). Stores backup destinations + schedule."""
    __tablename__ = "backup_config"
    id = Column(Integer, primary_key=True)
    instance_name = Column(String(128), nullable=False, default="domain-manager")
    encryption_password = Column(String(256), nullable=True)  # AES-256 on the zip; nullable = plain
    schedule_cron_hour = Column(Integer, nullable=True)  # 0..23; null = no schedule
    schedule_cron_minute = Column(Integer, nullable=False, default=0)
    retention_count = Column(Integer, nullable=False, default=14)

    # Telegram destination
    tg_enabled = Column(Boolean, nullable=False, default=False)
    tg_bot_token = Column(String(256), nullable=True)  # if null, falls back to env TELEGRAM_BOT_TOKEN
    tg_chat_id = Column(String(64), nullable=True)

    # SFTP destination
    sftp_enabled = Column(Boolean, nullable=False, default=False)
    sftp_host = Column(String(256), nullable=True)
    sftp_port = Column(Integer, nullable=True, default=22)
    sftp_username = Column(String(128), nullable=True)
    sftp_password = Column(String(512), nullable=True)
    sftp_path = Column(String(512), nullable=True, default="/")

    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())


class BackupRun(Base):
    __tablename__ = "backup_runs"
    id = Column(Integer, primary_key=True)
    started_at = Column(DateTime(timezone=True), server_default=func.now())
    finished_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(32), nullable=False, default="running")  # running | ok | error
    trigger = Column(String(32), nullable=False, default="manual")  # manual | schedule
    size_bytes = Column(Integer, nullable=True)
    filename = Column(String(256), nullable=True)
    destinations = Column(String(256), nullable=True)  # csv: "tg,sftp,download"
    error = Column(Text, nullable=True)
    counts = Column(Text, nullable=True)  # JSON of {table: n}
    triggered_by = Column(String(64), nullable=True)


class TelegramAdmin(Base):
    """Telegram recipients for OTP codes and abuse alerts."""
    __tablename__ = "telegram_admins"
    id = Column(Integer, primary_key=True)
    chat_id = Column(String(32), unique=True, nullable=True)   # NULL until they /start the bot
    username = Column(String(64), unique=True, nullable=True)  # @username without @
    display_name = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
