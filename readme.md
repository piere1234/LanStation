# LanStation — LAN Presence & File Sharing

LanStation is a small local-network web app you can run on a laptop or desktop during a LAN party, classroom, or office network.

It lets people on the same LAN:

- Open a single web page (by IP or `lanstation.local`)
- Pick a username and appear as “online”
- Share files with others on the network
- Download files shared by others

Everything runs locally on the server machine: no external server or cloud storage. Other users do not have to install anything; they simply browse to `lanstation.local` (or the server IP) in a normal web browser.

_**Status:** student project — not production-hardened, intended for very trusted LANs only._

## Features

### Presence

- Shows who is currently connected (one tile per logged-in user).
- Simple session-based login.
- Users choose a username to appear as “online”.

### File sharing

- Upload files from your machine to the server.
- Other users on the same LAN can download those files from the web UI.
- Everything stays on the local network.

### Authentication and storage

- Node.js + Express backend.
- Passwords stored as bcrypt hashes in PostgreSQL.
- Session-based authentication using `express-session`.

### LAN discovery via mDNS

- Uses multicast DNS (mDNS) to advertise `lanstation.local` on the LAN.
- Avoids dealing with raw IP addresses; users just type `lanstation.local` in their browser.
- If mDNS is not available, you can still connect via:
  - `http://localhost` (on the server itself),
  - `http://<server-ip>` (for example `http://192.168.1.10`),
  - or `http://<hostname>` (for example `http://my-laptop`).

## Project structure

```text
LanStation/
├─ secure-login/          # Node.js / Express application
│  ├─ server.js           # Main server (Express, sessions, mDNS)
│  ├─ protected/          # Protected HTML pages (admin.html, dashboard.html, etc.)
│  ├─ public/             # Public HTML pages, CSS (styles.css), client JS
│  ├─ assets/             # Static assets (currently unused or experimental)
│  ├─ setup.cmd           # Optional Windows helper script for setup
│  ├─ startserver.cmd     # Launch cmd file
│  └─ .env                # Environment file (created by script or by hand)
├─ .gitignore
└─ readme.md              # This file
```

## Requirements

**Server machine (where LanStation runs):**

- Windows 10 or Windows 11 (preferred)
- Node.js (LTS recommended)
- PostgreSQL (version compatible with your OS; examples below use 18.x on Windows)
- A local network (home router, school network, or similar)

**Clients (other machines on the LAN):**

- Any web browser (Chrome, Firefox, Edge, etc.)
- On some systems, mDNS support is required to use `lanstation.local`. Otherwise, use the server IP.

## Setup on Windows (server machine)

You can either use the helper script or set everything up manually.

### Option 1: Using `setup.cmd`

In `secure-login/` there is a script called `setup.cmd`. On a Windows 10/11 machine:

1. Open PowerShell or Command Prompt.
2. Navigate to the `secure-login` folder:

   ```cmd
   cd path	o\LanStation\secure-login
   ```

3. Run the script:

   ```cmd
   startserver.cmd
   ```

Alternatively just double click the setup.cmd file.

The script will typically:

- Check for `winget`.
- Install or verify Node.js.
- Try to install or verify the PostgreSQL client (`psql`).
- Try to detect PostgreSQL’s port (commonly `5432` or `5433`).
- If `.env` does not exist, ask you:
  - the PostgreSQL username you configured,
  - the PostgreSQL password,
  - the database name to use,
  - a session secret,
  - an admin setup code,
  - the host to bind.

It will then write a `.env` file and finally start `node server.js`.

If this script works end-to-end for you, you can skip the manual setup section below.

After that, you can use setup again to start the server, it won't reinstall everything, just start your server. I you want to reinitiate environment setup, delete.env.

### Option 2: Manual setup

If the script fails or you prefer to do things manually:

#### 1. Install PostgreSQL

Install PostgreSQL on Windows (for example via the official installer or `winget`). During setup, you will choose:

- A PostgreSQL superuser name (often `postgres`).
- A password for that user.
- A listening port (default is `5432`, sometimes `5433` on Windows).

Remember these values.

#### 2. Create `.env` manually

In the `secure-login` folder, create a file named `.env` with the following content, replacing the placeholders with your actual values:

```env
DATABASE_URL=postgres://username:password@localhost:port/lanstation
SESSION_SECRET=replaceme
ADMIN_CODE=replaceme
HOST=0.0.0.0
```

Where:

- `username` is your PostgreSQL user (for example `postgres`),
- `password` is the password you set during PostgreSQL installation,
- `port` is the port PostgreSQL listens on (commonly `5432` or `5433`),
- `SESSION_SECRET` is any random string used to sign sessions,
- `ADMIN_CODE` is used for admin setup in the app,
- `HOST` is the interface Node should bind to (`0.0.0.0` to accept LAN connections).

#### 3. Initialize the database using `psql`

Open a PostgreSQL shell (`psql`). On Windows you can usually find a shortcut called “SQL Shell (psql)” in the Start menu, or run it from a terminal.

You should see a prompt sequence similar to:

```text
Server [localhost]:
Database [postgres]:
Port [5433]:
Username [postgres]:
Password for user postgres:
```

Enter values that match your actual installation. Once logged in, you will see:

```text
psql (18.1)
WARNING: Console code page (437) differs from Windows code page (1252)
         8-bit characters might not work correctly. See psql reference
         page "Notes for Windows users" for details.
Type "help" for help.

postgres=#
```

Now run the following commands in `psql`:

```sql
CREATE DATABASE lanstation;
\c lanstation

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS "session" (
  sid varchar NOT NULL,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session"(expire);
```

This creates the `lanstation` database and the two tables used by the app.

## Running the server

From the `secure-login` directory:

1. Install dependencies:

   ```bash
   npm install
   ```

2. Make sure `.env` exists and is correctly configured.
3. Start the server:

   ```bash
   node server.js
   ```

If you are using the helper script, it will run `node server.js` for you at the end.

## Accessing the web interface

From any browser on the server machine:

- `http://localhost`
- or `http://localhost:<port>` (if you configured a non-default port in `server.js`)

From any other machine on the same LAN:

- `http://lanstation.local` (if mDNS is working on your network)
- or `http://<server-ip>` (for example `http://192.168.1.10`)
- or `http://<server-hostname>` (for example `http://my-laptop`)

You should see the LanStation web UI, where you can:

- Pick a username and appear online
- Upload a file
- Download files shared by others

## Development notes

**Backend:**

- Node.js
- Express
- `express-session`
- `bcrypt` (or `bcryptjs`) for password hashing
- PostgreSQL for persistence

**Networking:**

- mDNS via a Node library (for example `multicast-dns`) to advertise `lanstation.local`

**Frontend:**

- Static HTML/CSS/JS in `public/` and `protected/`

If you are modifying the project:

- Restart `node server.js` after changes.

For debugging:

- Run `node server.js` directly in a terminal to see runtime errors.
- Check the PostgreSQL logs if DB connectivity fails.

For mDNS testing:

- Use a Bonjour / mDNS browser on mobile or desktop to see whether `lanstation.local` is advertised.
- Some Android hotspot configurations do not support mDNS for clients in all directions; a standard Wi-Fi network usually works better.

## Security and limitations

This is a student / educational project and has several limitations:

- No HTTPS / TLS by default (plain HTTP on the LAN).
- No CSRF protection and limited hardening against web attacks.
- No rate limiting or sophisticated abuse protection.

Trust model assumes:

- a small, trusted LAN, and
- users are not actively trying to attack each other.

**Do not:**

- Expose this app directly to the internet.
- Use it to share sensitive or private data.
- Rely on it for any serious or production use.

If you want to make it more robust, you could:

- Put it behind a reverse proxy (nginx, Caddy) with HTTPS.
- Add CSRF protection and stricter input validation.
- Harden session cookies and authentication flows.
- Add file size and type restrictions.
