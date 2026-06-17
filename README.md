# HyperSoftTrade

Professional crypto trading terminal powered by [Hyperliquid DEX](https://hyperliquid.xyz).

**Business model:** free platform — revenue via affiliate trading fee commissions (referral code: `KNS`).

---

## Architecture

```
hypersofttrade/
├── frontend/   # Next.js 14 App Router · TypeScript · Tailwind CSS
└── backend/    # FastAPI · Python 3.11+ · hyperliquid-python-sdk
```

Both services are designed to deploy on **Railway** with **Supabase** as the database/auth layer.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, TypeScript, Tailwind CSS |
| Web3 | wagmi v2, viem, RainbowKit |
| State | TanStack Query |
| Backend | FastAPI, uvicorn |
| DEX | Hyperliquid Python SDK |
| Database | Supabase (Postgres + Auth) |
| Encryption | Fernet (cryptography) |
| Hosting | Railway (2 services) |
| Source | GitHub |

---

## Getting started

### Frontend

```bash
cd frontend
cp .env.local.example .env.local
# Fill in NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID and NEXT_PUBLIC_API_URL
npm install
npm run dev
```

### Backend

```bash
cd backend
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_KEY, ENCRYPTION_KEY
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

---

## Environment variables

### Frontend (`frontend/.env.local`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_HYPERLIQUID_REFERRAL_CODE` | Affiliate code — keep as `KNS` |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect Cloud project ID |
| `NEXT_PUBLIC_API_URL` | Backend service URL |

### Backend (`backend/.env`)

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase anon/service key |
| `ENCRYPTION_KEY` | Fernet key for encrypting private keys |
| `HYPERLIQUID_REFERRAL` | Affiliate code — keep as `KNS` |
| `FRONTEND_URL` | Frontend URL for CORS |

Generate a Fernet key:
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

---

## Deployment (Railway)

1. Push to GitHub — Railway auto-deploys on push.
2. Create two Railway services pointing to `frontend/` and `backend/` respectively.
3. Set environment variables in the Railway dashboard.
4. The `railway.toml` at the root configures both services.
