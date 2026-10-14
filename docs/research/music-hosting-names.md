# Music, Cloudflare hosting and title check

*Research pass, 14 October 2026. Items marked [unverified] come from memory or third-party sources. Everything else was checked against the cited page. Not legal advice.*

## 1. Spotify: not allowed

### Developer Policy (effective 15 May 2025)

The policy rules out what we wanted:

- **III.2:** "Do not create a game, including trivia quizzes."
- **III.6:** "Do not synchronize any sound recordings with any visual media… video, or similar content."
- **III.7:** "Do not permit any device or system to segue, mix, re-mix, or overlap any Spotify Content with any other audio content." That rules out crossfades and ducking.
- **III.4 and III.10:** no webcasting and no public performance.
- **II.4:** attribution and link-back are required.
- https://developer.spotify.com/policy

### Web Playback SDK

- Requires full Premium; mobile-only Premium plans don't qualify.
- Supported on desktop and mobile browsers, but iOS won't autoplay.
- The docs say it "must not be used in commercial projects without Spotify's prior written approval."
- https://developer.spotify.com/documentation/web-playback-sdk

### Access limits

- Since 15 May 2025, extended quota is only granted to registered organizations with a launched service and at least 250k monthly active users.
- Development mode has been capped at **5 allow-listed users** since Feb/Mar 2026.
- https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security
- https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access

### Verdict

**Not allowed, and not workable.** The only safe option is a "Radio off / External" station that mutes the game's music, with no API calls at all.

## 2. Apple Music (MusicKit JS v3): technically possible, legally grey

### What it needs

- Apple Developer Program membership (about $99/yr [unverified]).
- A developer token: a JWT signed with a MusicKit key.
- An Apple Music subscription for each player.
- It runs outside Safari, but forum reports describe failures in Chrome and Firefox.

### The terms

From the Apple Developer Program License Agreement, §3.3.6(D):

- "users must initiate playback and be able to navigate playback using standard media controls"
- "You may not… modify any MusicKit Content and MusicKit Content cannot be synchronized with any other content"
- "You may play MusicKit Content only as rendered by the MusicKit APIs or MusicKit JS". So no Web Audio routing and no effects. The audio is DRM-protected anyway.
- No charging for access or making money from it indirectly (in-app purchase, ads).
- Follow the Apple Music identity guidelines.
- Load MusicKit JS as a separate library; never bundle or re-host it.
- https://developer.apple.com/support/terms/apple-developer-program-license-agreement/

### Verdict

Apple doesn't ban games outright, but whether music playing under gameplay counts as "synchronized" has never been tested, and Apple hasn't answered forum questions about it (https://developer.apple.com/forums/thread/838157).

If it's ever built:
- Playback starts only when the player chooses.
- Plain play, pause and skip controls.
- No effects and no ducking.
- No ads or paywall around it.
- Apple branding as the guidelines require.

**It's optional and low priority.**

## 3. What we'll do instead

### Self Radio: the player's own files, as in GTA V

- Use `<input type="file" multiple accept="audio/*">`, which works in every browser, including iOS Safari.
- `showOpenFilePicker` and `showDirectoryPicker` work only in Chromium browsers, so check for them and fall back to the input.
- Copy the tracks into the browser's storage (OPFS or IndexedDB) so they survive reloads.
- Because the files are the player's own copies, effects, DJ chatter and crossfades are all fine. Nothing is uploaded or distributed.
- **Multiplayer rule:** custom-radio audio is never sent to the server or to other players. That would be redistribution or public performance.

### House stations

- Procedural or synthesized music.
- CC0 tracks, such as OpenGameArt filtered to CC0.
- Avoid unless the license fits:
  - Kevin MacLeod's music is CC BY, so it needs attribution.
  - Pixabay's license isn't CC0, and its tracks have drawn Content ID complaints [unverified].

## 4. Cloudflare

### Plans

- **Workers Free:** 100k requests/day and 10 ms of CPU per invocation.
- **Workers Paid ($5/mo minimum):** 10M requests a month and 30M CPU-ms included, and up to 5 minutes of CPU per invocation.
- Requests for static assets are free and unlimited on both.
- https://developers.cloudflare.com/workers/platform/pricing/

### Pages or Workers static assets

Cloudflare recommends Workers with static assets for new projects. Durable Objects don't attach to Pages.
https://developers.cloudflare.com/workers/static-assets/migrate-from-pages/

### COOP/COEP headers

- `_headers` can set them: up to 100 rules, 2,000 characters per header.
- They apply to static assets only. Function responses must set the headers in code.
- https://developers.cloudflare.com/pages/configuration/headers/

### Limits

- **Pages and Workers assets:** 25 MiB per file, and 20k files on Free or 100k on paid plans.
- **Workers:** 128 MB of memory per isolate.
- https://developers.cloudflare.com/pages/platform/limits/
- https://developers.cloudflare.com/workers/platform/limits/

### R2 storage, for map tiles

- $0.015 per GB-month; Class A operations $4.50 per million, Class B $0.36 per million.
- Free each month: 10 GB of storage, 1M Class A and 10M Class B operations.
- **Egress is free.**
- https://developers.cloudflare.com/r2/pricing/

### Durable Objects as game rooms

**Pricing**
- Running time is billed at 128 MB per object, by wall-clock time, while it isn't hibernating: $12.50 per million GB-s, with 400k GB-s included.
- Requests cost $0.15 per million after 1M included. Incoming WebSocket messages are billed at 20 messages per request; outgoing messages are free.
- https://developers.cloudflare.com/durable-objects/platform/pricing/

**Limits**
- `setTimeout` and `setInterval` keep an object from hibernating. A 20–30 Hz tick works, but the room is billed for every second it runs. **Stop the loop when the room empties.**
  https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- CPU time is 30 s by default (configurable to 5 min), and each incoming WebSocket message resets the count.
  https://developers.cloudflare.com/durable-objects/platform/limits/
- WASM is standard, and Rapier fits easily under the 64 MiB script limit. Watch the 128 MB memory limit for the world's colliders.
- No public example of Rapier running on a Durable Object was found [unverified that it performs well].

**Precedents**
- Cloudflare's Unity "Durable World": https://blog.cloudflare.com/building-real-time-games-using-workers-durable-objects-and-unity
- PartyKit, built on Durable Objects and acquired by Cloudflare: https://blog.cloudflare.com/cloudflare-acquires-partykit

**Caveats**
- WebSockets only (TCP).
- A deploy restarts the objects, so clients must reconnect.
- An object's location is fixed when it's created (use `locationHint`).

### Containers (GA 13 Apr 2026, Workers Paid only)

- Memory: $0.0000025 per GiB-s. CPU: $0.00002 per vCPU-s, billed on active use only.
- Included each month: 25 GiB-hours of memory and 375 vCPU-minutes.
- **Egress is $0.025/GB** after 1 TB (North America and Europe).
- https://developers.cloudflare.com/containers/pricing/

### Realtime, SFU and TURN

- 1,000 GB a month free, then $0.05/GB.
- Its data channels relay messages; they don't host a simulation.
- **No WebTransport server support was found** on Workers or Durable Objects [unverified absence].
- https://www.cloudflare.com/products/turn-sfu/

### Accounts and saves

- **D1:**
  - Free: 5M row reads a day, 100k writes a day, 5 GB.
  - Paid: 25B reads and 50M writes a month.
  - https://developers.cloudflare.com/d1/platform/pricing/
- **KV:** for config, not saves.
- **Turnstile:** free.
- **Access:** free for 50 users.

### Recommended shape

- **Game:** Workers static assets.
- **Map tiles:** R2.
- **Rooms:** one Durable Object per room, running the TypeScript and Rapier simulation and sending binary delta snapshots. The tick runs only while players are connected.
- **Accounts and saves:** D1.
- **Fallback:** Containers, only if a room outgrows a Durable Object's CPU or memory.

### Cost estimate (our own arithmetic)

For 10 rooms of 16 players, with 20 Hz client input, running 24/7:

| Item | Amount | Cost per month |
|---|---|---|
| Durable Object running time | 3.24M GB-s | ~$35 |
| Incoming messages | ~414M billed requests | ~$62 |
| Workers Paid base | | $5 |
| **Total** | | **~$100** |

- That's about $0.014 per room-hour.
- Batching input to 10 Hz brings it to about $70.
- A few hours of play a day costs about $25–30.

The same load on Containers would be about $65 in compute, plus about $100 or more in egress at about 15 KB/s of snapshots per player.

## 5. Title check

**Taken or problematic:**
- **Perimeter**: K-D Lab's RTS (2004, on Steam), Perimeter 2 (2009) and the Legate Edition (2024).
- **Zone 6**: a Steam game (March 2025), plus a 1983 game of the same name.
- **Kudzu**: a Game Boy/Switch game (2024).
- **Peachtree**: Sage's accounting software is a known software brand [trademark status unverified].

**No exact match on Steam:**
- **Five Points**: carries the NYC "Five Points Gang" association.
- **Peach State**, **Resurgens**, **Hooch**, **Top End**, **The Connector**.
- **ITP** and **OTP**: generic acronyms, so weak titles.
- **Spaghetti Junction**: only a board game on The Game Crafter uses it.

**Suggested working titles:**
1. **Resurgens**: the city motto.
2. **Spaghetti Junction**
3. **Southern Crescent**
4. **Cabbagetown**
5. **Hotlanta**: clear, but dated.

**Avoid:** MARTA and Ponce City Market (marks of real organizations), and Sweet Auburn (MLK's historic district).

No USPTO trademark search was done, and itch.io search couldn't be checked.

**Sources:**
- https://store.steampowered.com/search/?term=Perimeter
- https://store.steampowered.com/search/?term=Zone+6
- https://rawg.io/games/zone-6
- https://www.thegamecrafter.com/games/spaghetti-junction
- https://www.timeextension.com/games/switch-eshop/kudzu
