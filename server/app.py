import os
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.responses import FileResponse
from pathlib import Path
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Boolean, Text, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker, Session

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./employee_monitor.db")
# Use the installed Psycopg 3 driver for PostgreSQL URLs.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql+psycopg2://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql+psycopg2://", "postgresql+psycopg://", 1)
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "dev-admin-change-me")
ENROLLMENT_CODE = os.getenv("ENROLLMENT_CODE", "dev-enroll-change-me")

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()

class Device(Base):
    __tablename__ = "devices"
    id = Column(Integer, primary_key=True)
    device_name = Column(String(160), unique=True, index=True)
    employee_name = Column(String(160), index=True)
    device_token = Column(String(128), unique=True, index=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    last_seen = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)

class Activity(Base):
    __tablename__ = "activities"
    id = Column(Integer, primary_key=True)
    device_id = Column(Integer, ForeignKey("devices.id"), index=True)
    event_type = Column(String(60), index=True)
    app_name = Column(String(200), nullable=True)
    file_name = Column(Text, nullable=True)
    details = Column(Text, nullable=True)
    idle = Column(Boolean, nullable=True)
    occurred_at = Column(DateTime, index=True)

Base.metadata.create_all(bind=engine)
app = FastAPI(title="Employee Monitor API", version="1.0.0")

DASHBOARD_FILE = Path(__file__).resolve().parent / "dashboard" / "index.html"

@app.get("/", include_in_schema=False)
def dashboard():
    return FileResponse(DASHBOARD_FILE)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict to your dashboard domain in production.
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type", "X-Device-Token"],
)

def db_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def require_admin(authorization: Optional[str] = Header(default=None)):
    if not authorization or not secrets.compare_digest(authorization, f"Bearer {ADMIN_TOKEN}"):
        raise HTTPException(status_code=401, detail="Admin authentication required")

def require_device(x_device_token: Optional[str] = Header(default=None), db: Session = Depends(db_session)):
    if not x_device_token:
        raise HTTPException(status_code=401, detail="Device token required")
    device = db.query(Device).filter(Device.device_token == x_device_token, Device.is_active == True).first()
    if not device:
        raise HTTPException(status_code=401, detail="Unknown or revoked device")
    return device

class EnrollRequest(BaseModel):
    enrollment_code: str
    device_name: str = Field(min_length=1, max_length=160)
    employee_name: str = Field(min_length=1, max_length=160)

class EventIn(BaseModel):
    event_type: str = Field(max_length=60)
    app_name: Optional[str] = Field(default=None, max_length=200)
    file_name: Optional[str] = None
    details: Optional[str] = None
    idle: Optional[bool] = None
    occurred_at: Optional[datetime] = None

class BatchIn(BaseModel):
    events: list[EventIn] = Field(max_length=100)

@app.get("/health")
def health():
    return {"status": "ok", "version": "1.0.0"}

@app.post("/api/enroll")
def enroll(payload: EnrollRequest, db: Session = Depends(db_session)):
    if not secrets.compare_digest(payload.enrollment_code, ENROLLMENT_CODE):
        raise HTTPException(status_code=403, detail="Invalid enrollment code")
    existing = db.query(Device).filter(Device.device_name == payload.device_name).first()
    if existing:
        raise HTTPException(status_code=409, detail="Device name already enrolled")
    token = secrets.token_urlsafe(36)
    device = Device(device_name=payload.device_name, employee_name=payload.employee_name, device_token=token)
    db.add(device)
    db.commit()
    return {"device_id": device.id, "device_token": token, "message": "Device enrolled. Store the token securely."}

@app.post("/api/heartbeat")
def heartbeat(device: Device = Depends(require_device), db: Session = Depends(db_session)):
    device.last_seen = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True, "server_time": device.last_seen.isoformat()}

@app.post("/api/events")
def ingest(payload: BatchIn, device: Device = Depends(require_device), db: Session = Depends(db_session)):
    now = datetime.now(timezone.utc)
    device.last_seen = now
    for item in payload.events:
        db.add(Activity(
            device_id=device.id,
            event_type=item.event_type,
            app_name=item.app_name,
            file_name=item.file_name,
            details=item.details,
            idle=item.idle,
            occurred_at=item.occurred_at or now,
        ))
    db.commit()
    return {"accepted": len(payload.events)}

@app.get("/api/admin/overview", dependencies=[Depends(require_admin)])
def overview(db: Session = Depends(db_session)):
    now = datetime.now(timezone.utc)
    online_after = now - timedelta(minutes=3)
    devices = db.query(Device).filter(Device.is_active == True).all()
    return {
        "registered": len(devices),
        "online": sum(1 for d in devices if d.last_seen and d.last_seen >= online_after),
        "offline": sum(1 for d in devices if not d.last_seen or d.last_seen < online_after),
        "devices": [{
            "id": d.id, "device_name": d.device_name, "employee_name": d.employee_name,
            "last_seen": d.last_seen.isoformat() if d.last_seen else None,
            "status": "Online" if d.last_seen and d.last_seen >= online_after else "Offline"
        } for d in devices]
    }

@app.get("/api/admin/activities", dependencies=[Depends(require_admin)])
def activities(limit: int = 100, db: Session = Depends(db_session)):
    limit = max(1, min(limit, 500))
    rows = db.query(Activity, Device).join(Device, Activity.device_id == Device.id).order_by(Activity.occurred_at.desc()).limit(limit).all()
    return [{
        "employee": d.employee_name, "device": d.device_name, "event_type": a.event_type,
        "app_name": a.app_name, "file_name": a.file_name, "details": a.details,
        "idle": a.idle, "occurred_at": a.occurred_at.isoformat() if a.occurred_at else None
    } for a, d in rows]

@app.post("/api/admin/devices/{device_id}/revoke", dependencies=[Depends(require_admin)])
def revoke_device(device_id: int, db: Session = Depends(db_session)):
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    device.is_active = False
    db.commit()
    return {"revoked": True}

