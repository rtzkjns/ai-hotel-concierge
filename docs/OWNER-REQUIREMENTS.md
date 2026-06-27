# What We Need From the Owner — Kazzhol AI Program

**Date:** 2026-06-28
**Purpose:** The definitive checklist of everything we need from Kazzhol to build the three products. Based on the locked product descriptions in `PRD.md` (Program v1.0). Ordered by what blocks what — top items unblock the most work.

**Legend:** 🔴 blocks a product from shipping · 🟡 needed soon, work can start without it · 🟢 nice-to-have / can follow

---

## A. Access & Credentials (start these immediately — they have the longest lead time)

### A1. 🔴 Exely API credentials — *unblocks P1 live availability & booking*
The AI quotes real availability/prices and assists bookings by pulling **live** from Exely. We need:
- [ ] **`client_id`** and **`client_secret`**, generated in the Exely Extranet:
  *Hotel Settings → API Connections → Create Connection → tick **availability/rates + reservations** → Save → "Save and Open Access".*
- [ ] **OR** an Extranet **user account** for us with API rights, plus the **Exely Hotelier app** set up for the 2FA login, so we generate the keys ourselves.
- [ ] Confirm the **API section is enabled** on your Exely plan (if "API Connections" isn't visible, Exely support must switch it on).
- [ ] **One Exely cabinet for all 3 hotels, or a separate cabinet per hotel?** (We need keys for each cabinet that exists.)
- [ ] Confirm access level: read availability/rates **and** create reservations (read-write), not read-only.

### A2. 🔴 Meta Business Manager — *unblocks P1 (WhatsApp/IG/Messenger) AND P3 publishing*
Must be **rebuilt from scratch** (the prior attempt failed). This gates everything social, so start now.
- [ ] Business verification documents ready (company registration, etc. — Meta requires these).
- [ ] Admin access for us to the rebuilt Business Manager (or owner does the steps with us).
- [ ] Decision: **one shared WhatsApp business number, or one per property?**
- [ ] Any **existing WhatsApp Business** presence/number we should migrate vs. start fresh?
- [ ] Budget sign-off for a WhatsApp BSP if we use one (360dialog / Twilio) — see F2.

### A3. 🔴 Social account access — *unblocks P1 inbound IG/Messenger + all of P3*
- [ ] The **3 Instagram accounts** converted to **Professional** accounts, each linked to its **Facebook Page**.
- [ ] Admin/role access to each **Facebook Page** and Instagram account.
- [ ] A full inventory: every social account per property we should connect (handles + which property each belongs to).

---

## B. Hotel Knowledge & Data Sources (the "brain" — needed for P1, reused by P3)

### B1. 🔴 Static knowledge base content — in **RU / KK / EN**, per property
The AI answers FAQs from this. For **each** of the 3 hotels, we need the facts (we'll structure them; you provide the content):
- [ ] Room types + descriptions + standard rates/price list
- [ ] Amenities (pool, restaurant, parking, gym, etc.) and which property has what
- [ ] Check-in / check-out times and policies (cancellation, children, pets, payment)
- [ ] Location, address, how to get there, parking details
- [ ] Breakfast / dining info, restaurant names & hours
- [ ] FAQs you already get asked a lot (and the correct answers)
- [ ] **Confirm all of the above can be provided in all three languages** (RU/KK/EN), or tell us which language you'll provide and whether we translate.

### B2. 🔴 Live data sources — *the owner's "pull data from the source" requirement*
The AI pulls **dynamic** facts live, never invents them. Tell us, per data type, the source of truth:
- [ ] **Availability & current prices** → Exely (confirmed) — covered by A1.
- [ ] Is there a **separate PMS** we should also read? If so, which one + API access.
- [ ] Anything maintained in **Google Sheets / other tools** the AI should read live (e.g. special offers, seasonal pricing, event availability)? Provide access.
- [ ] **Who keeps each source current**, so the AI always pulls accurate data?

### B3. 🟡 Brand voice & language rules — *feeds P1 and P3*
- [ ] Tone: **formal or warm/casual?** (We've assumed warm/friendly — confirm.)
- [ ] **Default language** when we can't detect the guest's language?
- [ ] Any existing **style guide**, brand book, or **banned phrases / things never to say**?
- [ ] How should the AI **sign off / identify itself** (as the hotel, as an assistant)?

---

## C. Operations & Handoff (P1)

- [ ] 🔴 **Who are the human agents** that take over escalated chats? (names/roles, per property or central)
- [ ] 🔴 **Where do escalations land?** A new web dashboard we build, or a tool they already use (a staff group, existing CRM/helpdesk)? (Today the chain has no unified inbox — confirm.)
- [ ] 🟡 Working hours / coverage expectations (the AI is 24/7; when can a human realistically take over?)
- [ ] 🟡 Rules for when the AI **must** escalate (complaints, refunds, VIPs, anything else?)

---

## D. "Kazzhol for Groups" Portal (P2)

The portal is an **RFP/quote** model: a company registers, gets a cabinet, submits a group request, staff send a quote, company accepts.
- [ ] 🟡 **Who handles group sales** on the hotel side (the staff who'll receive RFPs and build quotes)?
- [ ] 🟡 What goes in a **group request**? (dates, # rooms, # guests, property, meals, events, budget — confirm the fields)
- [ ] 🟡 **Where does group pricing come from** — manual quotes built by sales (our v1 default), or live Exely group rates?
- [ ] 🟡 Access/where on the **main site** the portal should live (subdomain, page, link), and who controls the site/domain.
- [ ] 🟢 What info should a **company profile** hold (company name, contact, tax/billing details)?
- [ ] 🟢 Do they want **v2 later**: online payment, post-booking management (rooming lists, guest names, invoices/documents)?

---

## E. AI Social Posting (P3)

- [ ] 🟡 **Brand training material** — a set of **past best-performing posts** (captions + images) per property, so the AI learns the Kazzhol style.
- [ ] 🟡 The **content/style guide** for posting: recurring themes, hashtags, emoji use, do's & don'ts, posting cadence.
- [ ] 🟡 **Who the SMM managers are** and which accounts each manages.
- [ ] 🟡 Approval workflow: confirm **a manager approves each post before it publishes** (v1), graduating to auto-publish later.
- [ ] 🟢 Which **post languages per account** (all 3, or per-account audience)?
- [ ] 🟢 Any accounts that are **personal Instagram** (publishing-API limited) vs Professional — affects what we can auto-publish.

---

## F. Business & Setup

- [ ] 🟡 **Budget envelope** — drives WhatsApp BSP choice, LLM usage tier, hosting, and the P2 web stack.
- [ ] 🟡 **WhatsApp BSP decision** (360dialog / Twilio / direct Meta) — depends on budget + volume.
- [ ] 🟡 **Hosting / data residency** — any requirement to host in Kazakhstan / localize guest & company PII?
- [ ] 🟡 **Success metrics** — confirm targets (e.g. ≥60% AI-resolved DMs in 3 months, <1 min first response).
- [ ] 🟢 **Timeline / priorities** — confirm build order P1 → P3 → P2 and any hard deadlines.
- [ ] 🟢 A single **point of contact** on the hotel side for approvals and access requests.

---

## The 3 things that unblock the most, fastest

If the owner does nothing else first, these three remove the biggest blockers:
1. **A1 — Exely keys** (or Extranet access) → turns on live availability & booking for P1.
2. **A2 — Start the Meta Business Manager rebuild** → gates WhatsApp + Instagram + Messenger (P1) and all P3 publishing; longest lead time.
3. **B1 — Hotel knowledge in RU/KK/EN per property** → without it the AI has nothing accurate to say.

Everything else can proceed in parallel while these are in flight.

---

## Ready-to-send messages (Russian)

**To the owner — credentials & access:**
> «Чтобы начать делать ИИ для директов и бронирований, нужно от вас:
> 1) **Exely API** — зайдите в Extranet: *Настройки отеля → Подключения по API → Создать подключение*, отметьте доступ к **наличию мест/тарифам и бронированиям**, нажмите *Сохранить и открыть доступ*, и пришлите мне **client_id** и **client_secret**. Если раздела «Подключения по API» нет — попросите менеджера Exely его включить. Один кабинет на все 3 отеля или у каждого свой?
> 2) **Meta Business Manager** — надо собрать заново (нужны документы компании для верификации). Дайте мне доступ админа, когда создадим. Один номер WhatsApp на всю сеть или по одному на отель?
> 3) **Instagram (3 аккаунта)** — перевести в Professional и привязать к Facebook-страницам, дать мне доступ.
> 4) **Информация по отелям** на 3 языках (RU/KK/EN): номера, цены, удобства, заезд/выезд, правила, FAQ — по каждому из 3 отелей.»

**To Exely support (if the API section is missing):**
> «Здравствуйте! Просим включить раздел **API (Подключения по API)** для нашего аккаунта в Extranet, чтобы создать интеграцию для проверки наличия мест, тарифов и бронирований через API (Exely Connect / Public API). Подтвердите, входит ли API в наш тариф.»
