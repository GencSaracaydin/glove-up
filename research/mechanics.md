# Glove Up: Reference Mechanics

This reference is built from one 72:37 single-player walkthrough of a motion-controlled cartoon boxing game, called "the reference" below. Eight agents each logged one slice of the video:

| Slice | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 |
|---|---|---|---|---|---|---|---|---|
| Video time | 00:00–09:00 | 09:00–17:57 | 18:00–27:00 | 27:00–36:00 | 36:00–45:00 | 45:00–53:57 | 54:00–62:57 | 63:00–72:37 |

Their logs were merged here. Where the slices disagreed, the point was re-measured on the source video. Merged 2026-11-05.

**Scope.** This file covers mechanics, timing and information design only. It does not describe the reference's characters, names, art, logos, music or recorded sounds, and none of those should be copied. Glove Up makes all of them from scratch. Opponents are identified only by bout number (B01–B27, Appendix A) and rating (written like "r1017").

**Tags on every number**
- **M = MEASURED** by a slice agent. The timestamp is the position in the source video as mm:ss.s; minutes run past 60, so 63:26.7 is valid. "×n" means n instances.
- **V = MEASURED during this merge**, by frame analysis of the source video (methods in Appendix B).
- **E = ESTIMATED**: an inference or a design recommendation, not measured directly.

**Units**
- **wedge**: 1/10 of a health pie.
- **game-s**: one second on the round clock.
- **s**: one real second.
- **live**: time while the round clock is running.

**Dataset.** 27 bouts (B01–B27), plus one bout the uploader cut. Across them: 75 opponent knockdowns, 10 player knockdowns, 27 wins by KO, 0 losses, 0 decisions, no training modes.

## Quick reference

| Rule | Value | Tag |
|---|---|---|
| Bout | Up to 3 rounds, with a 3:00 clock each. | M |
| Clock speed | 1 game-s per 0.333 s (3.0×). Hit-stop stalls stretch a full round to 65–76 s of live time. | M |
| Health | One 10-wedge pie per fighter. No regeneration, no top-up between rounds, no chip damage. | V |
| Damage | Ordinary clean hit: 1.0–1.5 wedges. Counter or heavy hit: 2.5–4 wedges. | M/V |
| Knockdown | A clean hit on an empty or almost-empty pie. | M |
| Refill on rising | 8 wedges, then 6, then 4. | V |
| KO | Still down at "10". A 4th knockdown in a bout was always a KO (10 of 10). | M |
| Count | 1.08 s per number. A knockdown stops play for about 8.1 s + 0.92 s × the count reached. | M |
| Opponent rise count | Mean 5.6, 6.7 and 8.0 on knockdowns 1, 2 and 3. Chance of staying down: 19%, 27%, 38%, then 100% on the 4th. | M |
| Block | Green ring at the contact point, no damage. The AI counters a blocked punch 0.2–0.82 s later. | M |
| Dodge | Lean away. The missed glove stays out for 0.6–0.7 s, and a 0.5–0.9 s slow-motion counter window opens. | M |
| Getting hit | One frame of speed lines, then a 0.3–0.75 s cut to an over-the-shoulder shot. | M |
| Hit-stop | 0.15–0.25 s for an ordinary hit, 0.45–0.6 s for a big hit or counter, about 0.7 s for a knockdown counter. | M |
| Opponent tells | Ordinary punches: 0.17–0.45 s. Power punches: 0.4–0.8 s. | M |
| Rating | About +75 per clean KO win, falling to +63 near rating 1550. The first time you are knocked down costs about 20. PRO starts at 1000. The next opponent is rated 50–148 above you. | M |

## 0. Contradictions between slices and how they were resolved

| # | Topic | What the slices said | Resolution | Basis |
|---|---|---|---|---|
| C1 | Number of pie segments | 12 (S1, S3, S6) vs 10 (S2, S4, S5, S7, S8) | **10 wedges** on both pies in every bout. Readings reported as x/12 were converted as fractions. | V: spoke detection found 10 dark spokes, 36° apart, at 16:53.0, at 18:50.4 (the frame S3 cited for "12") and at 59:28.1. Visual count at 1:17.5 and 6:15.0 also gives 10. |
| C2 | Regeneration during a round | S2: 0.3–0.45 wedge/s. S3: 1 every 3–5 s. S7: 1 every 7–20 s. S6: "maybe". S4, S5, S8: none. | **None.** | V: blink-aware tracking of the player pie stayed flat at 8.8 (59:28.6–59:38.0), at about 1.8 (34:16–34:39), and at 0.9 (30:38.7–30:41.9 and 68:31–69:09). The apparent regeneration is an artifact of the blinking wedge in C3 when frames are sampled at 5–15 fps. S3 also counted camera cuts as hits. |
| C3 | Blinking lost wedges (only S1 noticed) | — | **Confirmed and refined.** Up to one wedge on the lost side of the health edge blinks at 10 Hz: lit for 1 frame, dark for 2 frames at 30 fps. It blinks for as long as the pie is visible, still blinking 30+ s after the hit. | V: frame by frame at 16:52.5–16:54.4, 28:25.6–28:27.4, 30:39.0 and 34:25.0. |
| C4 | Top-up between rounds | S4: +10–15%. S7: about +1 wedge. S8: 2.5 → 3. S2, S5, S6: none. | **None.** | V: 0.9 → 0.8 wedges across the 68:56.6 break. M S5: pie empty through the 41:29 break (V: frame 41:59.8 fully dark). M S2: 3/10 → 3/10 at 14:13.9–14:15.9. |
| C5 | Does a blocked punch still cut the camera? | S4: yes (28:25.6). S1: no. | **No.** A block shows a green ring, with no cut and no pie. The S4 example was a landed hit: the pie fell from 10 to about 8.8, and the blink made some frames look full. | V: 30 fps strip 28:25.4–28:26.3. M: S1 2:54.27. |
| C6 | What a block by the opponent looks like | S1: small purple swirl (tentative). S2–S8: green ring. | **Green ring** for every block, whoever blocks. | M: 50:12.33, 57:06.2, 63:38.3 |
| C7 | Clock rate | 3.0× (S1–S5, S7) vs 2.4–2.6× (S6, S8) | One tick is **0.333 s (3.0×)**. The 2.4–2.6× figure is the average once hit-stop stalls are included. | M: in S7, 509 of 773 ticks were exactly 10 frames. |
| C8 | Hit-stop length | 0.15–0.3 s (S1, S2) vs 0.5–0.8 s (S4, S5, S7) | **Two tiers.** 0.15–0.25 s for an ordinary hit. 0.45–0.6 s for a big hit, a counter, or a combo's second hit. About 0.7 s for a knockdown counter. S4 and S5 measured how long a clock reading stayed on screen, not the stall itself. | M: S1 tick gaps of 0.47–0.57 s vs 0.80–0.93 s; one reading held 1.0 s at 52:12.5–52:13.5. |
| C9 | Clock during the player-hit cut | Stopped (S4) vs running (S7) | Ordinary hits on the player **do not stop the clock**. Heavy hits on the player stall it about 0.45 s. | M: S7 statistics (8% of player hits fall in a stretched tick, vs a 23% baseline). V: 28:25.6, normal ticks. M: 5:55.30, 22:22.53–22:23.33. |
| C10 | What triggers a knockdown | S4: the punch that empties the pie. S3, S5, S6, S7: the next hit on an empty pie. | **Both happen.** Usually one hit leaves the pie looking empty (often a hidden sliver), and the **next clean hit** floors the fighter. That gap was 0.5 s (44:38.25 → 44:38.75), about 8 s for the player (42:08 → 42:16.13) and about 20 s for an opponent (42:23.7 → 42:45). A heavy counter can empty the pie and floor in one blow (30:12.93). | M as listed |
| C11 | Refill when rising | S3: 75/50/25%. S4: 70–75/55–65/25–45%. S6: 50–75%. S7: 6/5 and 4–5/3. | **8 wedges, then 6, then 4.** The player gets 8, then 6. | V: 8/10 after a first knockdown in 9 of 9 bouts checked, 6/10 after a second in 5 of 6 (one read 5 mid-animation), 4/10 after a third in 2 of 2. |
| C12 | Referee | S3: a referee counts over the downed fighter. | **There is no referee.** S3 mistook the standing player, who is drawn solid in the knockdown camera, for a referee. | V: frames 19:06.0 and 24:47.0. All other slices agree. |
| C13 | Player gets up fast "at count ~2 by pumping" (S8) | — | **Editing artifact.** The uploader jump-cut from "Down" (70:54.0) to "6" (70:54.6), and the player rose after 6. | V: 5 fps strip 70:52.2–70:57.0 |
| C14 | B06's rise count on its first knockdown | 6 (S1, at 8:44.4) vs about 3 (S2, outside its slice) | **6** | M: S1 |
| C15 | B14's rise count on its first knockdown | 6 (S3, at 26:48.9) vs 4–5 (S4, outside its slice) | **6** | M: S3 |
| C16 | Knockdowns B19 took before the KO | 3 (S6) | **KO on the 4th** (44:39, 45:25, 46:10, 46:38.5). S6 missed the 44:39 knockdown, which falls in S5. | M: S5 + S6 |
| C17 | When the player reached PRO | Crossed at 1170 (S6) | **1047**, after B17 at 39:57 | M: S5 |
| C18 | Camera type | "First person" (S5) vs "third person, over the shoulder" (the others) | **The same camera:** just behind and above the player's head, with the body about 50% transparent and the gloves solid. | All slices |
| C19 | Partial wedges | S5: the pie rounds up. S4, S7: partial wedges are drawn. | **Partial wedges are drawn.** The pie first shows the pre-hit value and drains 0.5–0.8 s later, so it can look full right after a light hit. | V: 59:29.0 (a sliver of about 0.9 wedge), 59:28.4 → 59:28.6 |

## 1. Match flow

### 1.1 Structure
- A bout has **up to 3 rounds** (M). Three round lamps sit above the clock and show done, current and future rounds. Round 3 is announced as the final round (M 31:32.6).
- **The round clock** starts at 3:00 and counts down 1 game-s every **0.333 s** (M: S7; 4 ticks in 1.34 s at 22:19.53 → 22:20.87). With no stalls, a round would take 60 s.
  - It stalls briefly on big hits (§2.8).
  - It freezes and hides during knockdowns.
- **A full round takes 64.9–75.5 s of live time, median about 71 s**, because of hit-stop stalls (M).
  - 28:16–29:44: 64.9 s
  - 47:26.2–48:48: 70.2 s
  - 67:17.3–68:56.6: 72.1 s
  - 63:26.7–65:09.7: 73.8 s
  - B22 round 1, the 54:00 window: 75.5 s
- **With knockdown stoppages, a round takes 76–94 s of wall-clock time** (M: 21:50.1–23:06.3 with one knockdown; 12:40.4–14:14.4 with two).
- **All 27 bouts ended with a 10-count KO.** 11 ended in round 1, 15 in round 2 and 1 in round 3. No decision, draw or loss was ever shown (M, Appendix A).
- **Health carries over between rounds.** It is not reset and gets no top-up (V; see C4).
- **"Play again" goes straight to the next VS card after a win.** The game picks the opponent (§7.2), and there is no ladder screen (M, all slices).
- **The first bout of a new profile** (rating 0) runs a live 6-step tutorial before its clock starts (M 0:12–1:12; see §8).

### 1.2 Timeline of one bout

| Phase | Duration | Evidence |
|---|---|---|
| Black frame, then the VS card | About 0.5 s of black. The card shows for 1.5–2 s but waits for a confirm press (once 10.5 s). | M 44:05; 7:20.5; 59:05.5–59:16 |
| Arena establishing shot | About 1 s | M 7:22.5; 44:08 |
| "Round N" banner over the arena, with a spoken round call | 1.5–2.5 s | M 44:09–44:11; 34:43.5–34:45.3 |
| Camera flies into the ring, then a ring-level shot of both fighters | 1.5–2 s | M 28:13–28:14; 34:45.7–34:47.3 |
| "Fight!" call and bell | 0.75–1.0 s | M 49:47.53–49:48.27 |
| "Fight!" to the clock running and the HUD fading in | 0.5–1.3 s (median about 0.8) | M 37:06.5 → 37:07.0; 42:26.6 → 42:27.85 |
| **VS card to the first clock tick** | **7–10 s (median about 8.5)** | M 7:20.5 → 7:29.3; 44:06 → 44:14.4; 49:40.5 → 49:48.5; 63:18 → 63:26.7 |
| A full round, live | 64.9–75.5 s | §1.1 |
| **Break between rounds** (clock at 0:00 to the next round's clock) | **7.8–10 s (median 8.0)** | M 55:14.70 → 55:22.53, 57:53.43 → 58:01.27 and 60:45.73 → 60:53.57 (all 7.83 s); 68:56.6 → 69:04.7; 45:52 → 46:02 |
| What happens in the break | Bell at 0:00. Fighters drop their guard and hold for about 1.5 s while the HUD hides. Wide arena shot with "Round N" (about 2 s). Fly-in (about 2 s). "Fight!" and bell. | M 34:39.6 → 34:48.8 |
| Knockdown stoppage (the blow to the clock running again) | About 8.1 s + 0.92 s × the count reached: 11.3 s for a rise at 4, up to 16.1 s for a rise at 9 | M: S7 fit; 63:59.5 → 64:13.3 (rose at 6, 13.8 s); 64:35.6 → 64:51.3 (rose at 8, 15.7 s) |
| KO blow to the "KO" call | 13.0–14.3 s | M 24:41.4 → 24:55.1; 55:30.3 → 55:43.5 |
| "KO" to the logo wipe | 1–2 s | M 32:20.25 → 32:22.5 |
| KO replay | 8–23 s, as one or two camera passes | M 24:58–25:06 (8 s, one angle); 43:32–43:51 (19 s, two angles) |
| White flash or fade | 1–2 s | M 2:23.7–2:24.8 |
| Win banner with confetti | 3–5 s | M 2:25–2:30; 18:31–18:34 |
| Winner pose, with the beaten opponent behind | 3–4 s | M 2:30–2:33 |
| Results (rating) card, then its buttons | The buttons appear 1–2.5 s after the card. | M 2:33.5 → 2:35 |
| **"KO" to the next bout's "Fight!"** | **33–58 s (median about 47)** | M 46:51.5 → 47:25.5 (34 s); 1:58.0 → 2:46.4 (48 s) |

### 1.3 State machine (E)

```
VS_CARD → ROUND_INTRO → LIVE
LIVE --clean hit on an empty pie--> KNOCKDOWN → COUNT --rises--> STANDOFF → "Fight!" → LIVE
                                             COUNT --reaches 10--> KO   (a 4th knockdown never rises)
LIVE --clock reaches 0:00, round < 3--> ROUND_BREAK → ROUND_INTRO → LIVE
LIVE --clock reaches 0:00, round 3----> DECISION              (never observed)
KO → KO_CALL → WIPE → REPLAY → FLASH → WIN_BANNER → WINNER_POSE → RESULTS → VS_CARD
```

### 1.4 Edge rules
- **The clock never cuts a count short.** A fighter knocked down with 0:03 left was counted out (M 20:49.5 → KO at 21:04.1).
- **A fighter who rises fights on, even with 0:02 left** (M: knockdown at 0:02 at 22:53.6, restart at 23:04.9, bell at 23:06.3). There is no "saved by the bell".
- **Each knockdown costs 0–4 game-s**, because the clock keeps running during the fall until the HUD hides (M: 2:12 → 2:12 at 6:04; 2:05 → 2:01 at 13:01–13:14; 0:48 → 0:46 at 30:54–31:08.5).
- **There is no grace period after "Fight!"** Opponents punch 0.33–1.0 s after the clock starts, both at round starts and after knockdowns (M 2:46.70; 49:49.2; 65:18.3; 69:05.7).

## 2. Combat

### 2.1 Inputs

The reference teaches six inputs in its first-bout tutorial (M 0:12–1:10). Together they give 2 guard heights, 2 punch heights and a lean in 4 directions.

| Tutorial step (M; our step ids — the card titles are our own) | Reference input | Webcam / MediaPipe mapping (E) |
|---|---|---|
| `stance` (0:12–0:20) | One controller per hand, fists up | Calibrate the head's offset over the shoulders and the wrist heights from a 1 s hold; the neutral position itself is learned again in every bout (from the first steady second with the hands up). |
| `guard-head` (0:22–0:31) | Both hands in front of the face | Both wrists inside a box around the face: the nose ± 0.6 shoulder widths, above the shoulder line. |
| `punch-head` (0:32–0:41) | Thrust either hand forward at head height | A fast wrist extension away from the shoulder that ends above the shoulder line. |
| `guard-body` (0:42–0:50) | Both hands in front of the torso, tilted inward | Both wrists between the shoulder and hip lines, inside the torso. |
| `punch-body` (0:52–1:00) | Thrust forward at body height | The same extension, ending below the shoulder line. |
| `dodge` (1:02–1:10) | Tilt the body forward, back, left or right | Sideways: the nose moves at least 0.35 shoulder widths from neutral. Back or forward: the upper body sways at least ≈ 11 cm, at any distance from the camera (E; 12 % of the shoulder width is that sway at ≈ 1 m). A forward tilt dodges what a duck dodges (straights and hooks); a back lean dodges head punches. |

**Feel targets (E)**
- The on-screen gloves follow the hands 1:1, as in the reference.
- A punch should register within 100 ms of peak wrist speed.
- A lean should move the view within 150 ms, to match the reference's slide of 0.15 s or less (M 56:20.93 → 56:21.06).

### 2.2 Player punches
- The glove reaches full extension in 0.07–0.13 s and pulls back in about 0.15 s (M 18:49.95 → 18:50.12; S1 7:34.97).
- **Punch volume (M):**
  - In exchanges the player throws 0.8–2 punches/s: 13 in 9.2 s against B07, 67 in 52 s against B10, 98 in 118 s against B09 (S2).
  - Flurries reach 5–6 punches/s: 6 alternating punches at 7:34.97–7:35.97.
  - Two clean hits can land 0.23 s apart (13:22.30 / 13:22.53).
- **Punch types (M):** straights, wide hooks and upward punches. Height decides head or body (S3; body shot at 58:13.8 → 58:14.0).
- **Speed:** a fast punch draws a blue motion trail, and the knockdown blow was often a fast one (M 45:24.75, 50:24.75, 50:27.5, 53:35.5). Give fast punches a damage bonus (E).
- **Misses:** a miss draws a colored streak and has no other effect (M 26:08.6–26:08.8).

### 2.3 How a punch resolves

**Clean hit by the player**
- When: the punch lands in a zone the opponent isn't guarding.
- Feedback:
  - A pink starburst at the contact point (0.3–0.5 s), with sparkles.
  - The opponent's head snaps back for about 0.2 s, and the face shows pain for 0.8–1 s.
  - The opponent's pie pops in; lost wedges break into white shards with a ring pulse.
  - The camera does not cut.
- Damage: 1.0–1.5 wedges.
- Then: 0.15–0.25 s of hit-stop, and the opponent reels for 0.5–0.7 s.
- Evidence: M 10:38.70; 44:16.0–44:16.8; 63:37.6

**Counter by the player**
- When: the punch lands while the opponent's punch is out or pulling back, or just after the opponent misses.
- Feedback: a bigger, longer burst (0.2–0.5 s), a 0.5–0.6 s freeze, and the opponent's glove hangs in the air for about 0.47 s.
- Damage: 2–4 wedges.
- Then: often sets up a knockdown, or causes one.
- Evidence: M 1:23.93–1:24.40; 44:22.3; 47:58.47; 51:42.6

**Block (either fighter)**
- When: a glove or guard covers the zone where the punch lands.
- Feedback: a green ring expands at the contact point for 2–3 frames, then fades (0.07–0.2 s in all). No camera cut and no pie.
- Damage: 0 (no chip damage).
- Then: the AI counters a blocked player punch 0.2–0.82 s later.
- Evidence: M 2:54.27; 50:12.33; 57:06.2; V 28:25

**Miss or slip (either fighter)**
- When: the target has leaned or slipped away.
- Feedback: the punch passes with a streak (red for the opponent's punches).
- Damage: 0.
- Then: the attacker's glove stays out for 0.6–0.7 s. A dodge by the player also triggers slow motion (§2.5).
- Evidence: M 56:21.06–56:21.73; 57:14.56–57:15.16

**Clean hit on the player**
- When: the opponent's punch lands on an unguarded zone.
- Feedback:
  - One frame of orange radial speed lines, then a hard cut to a tight, solid over-the-shoulder shot with a blue and white burst (0.3–0.75 s), then a hard cut back.
  - The blue pie pops in showing the pre-hit value and drains 0.5–0.8 s later.
- Damage: 1.0–1.2 wedges.
- Then: the clock keeps running, and follow-up punches can land while the view is away.
- Evidence: V 59:27.76 → 59:28.6 (10 → 8.8); V 16:52.5 (about 1.1)

**Heavy hit or counter on the player**
- When: the opponent counters a blocked punch, a miss or a slip, or a power punch lands.
- Feedback: as for a clean hit, plus a purple burst. The cut lasts 0.6–1.25 s.
- Damage: 2.5–4 wedges.
- Then: the clock stalls about 0.45 s. At low health this often knocks the player down.
- Evidence: V 30:38.1 (4.9 → 0.9); M 30:12.93 (−3.4); 40:32.5–40:33.75

**Trade**
- When: both punches land within the same frame.
- Feedback: both bursts show and both pies shatter.
- Damage: both fighters take damage.
- Then: only one knockdown was resolved. The opponent went down; the player, near 0, stayed up.
- Evidence: M 41:45.3 (seen once)

### 2.4 Guard
- **The guard has two heights and covers zones.**
  - A high guard (gloves at the face) blocks head punches. Body punches go under it (M 13:20.63, 62:11.86, 63:43.7, 68:50.5).
  - Hooks go over a low guard (M 65:24.5).
  - Dropping one glove can block a body shot (M 40:35.3, 45:10.1).
  - The glove has to be where the punch lands; holding a guard somewhere else doesn't count (M 13:20.43–13:20.70).
- **There is no chip damage, no guard meter and no stamina** (M, all slices; V 28:25).
- **Punching into a guard is risky.** The main way the player gets hurt is an AI counter 0.2–0.82 s after a green ring, which lands while the player's glove is still out (M 16:52.27 → 16:52.47; 12:57.73 → 12:58.55; 42:15.73 → 42:16.13, which caused a knockdown).

### 2.5 Dodge, slow motion and counters
- A lean slides the view about 1/4–1/3 of the screen width in 0.15 s or less (M 56:20.93 → 56:21.06; 26:08.3–26:08.5).
- A dodged punch misses with a red streak. There is no damage and no camera cut (M 26:08.6–26:08.8; 66:15.6–66:16.0).
- **A successful dodge opens a slow-motion window** (M).
  - The frame smears, the opponent's glove hangs out, and the clock stops for about 0.5–0.9 s. At 57:14.6–57:15.4 one clock reading held for 0.87 s or more; at 4:12.10–4:12.90 the freeze lasted about 0.8 s; see also 56:21.2–56:22.9.
  - The player's counter landed inside this window: 0.07–0.35 s after the miss ended, and 0.87 s after the opponent's punch started (47:58.47, 51:42.6; 56:21.93, 57:15.30).
- Dodge-then-counter caused many of the knockdowns from 45:00 onward (M 47:58.47, 51:42.6, 52:13.17, 57:15.30, 66:16.3).
- The window is short: a strong opponent threw again about 1.1 s after missing (M 26:08.6 → 26:09.7).
- The AI can wait out a lean. One opponent held a cocked punch for up to 1.0 s until the player came back to center (M 33:57.93 → 33:59.0).
- Opponents slip too: they lean or sway out of the way, then counter 0.2–0.3 s later (M 12:42.85 → 12:43.42; 33:24.5 → 33:25.03; 67:23.4 → 67:23.9).

### 2.6 Damage (in wedges of a 10-wedge pie)

| Event | Wedges | Hits from full to a knockdown | Evidence |
|---|---|---|---|
| Player's ordinary clean hit | 1.0–1.5; an occasional light hit is about 0.5 | 6–9 (4 if counters land) | M 24:34.9–24:41.4 (about 8 hits); 33:07.6–33:38.3 (6–7); 46:03.75–46:09.75 (1 each) |
| Player's counter | 2–4 (one was about 5) | — | M 44:22.3 (V: 5 wedges left at 44:23.0); 67:18.2 |
| Opponent's ordinary hit on the player | 1.0–1.2 | About 8–10 | V 59:27.76; V 16:52.5; M 68:01–68:27 (9 → 2 over 7 hits) |
| Opponent's heavy hit or counter on the player | 2.5–4 | — | V 30:38.1 (−4); M 30:12.93 (−3.4); V 40:32.5 (about −3 to −4) |
| Blocked punch, either fighter | 0 | — | M, all slices |
| Outlier: one opponent took 2–4 wedges per hit | — | 4 | M 67:18.2–67:38.7 (B26) |

An opponent's ordinary hit does about the same damage at every rating. What rises with rating is how often hits land and how many heavy counters there are (M; compare S1 with S8).

### 2.7 Reaction windows

| Window | Value | Evidence |
|---|---|---|
| Opponent reels after a clean hit and cannot guard | 0.5–0.7 s; a second punch usually lands | M pairs at 53:16.4/16.9, 55:29.6/30.3, 62:39.4/40.1 |
| Opponent's guard is back up after a clean hit | About 0.7 s | M: hit at 63:37.6, block at 63:38.3 |
| Opponent covers up after two quick hits | High guard for about 0.9–1.0 s | M 50:11.4–50:12.3 |
| Opponent stunned by a counter | About 0.47 s; the follow-up landed 0.8 s after the counter | M 1:23.93–1:24.40 → 1:24.73 |
| Opponent's glove stays out after a miss | 0.6–0.7 s (about 0.3 s against the top opponents) | M 56:21.06–56:21.73; 40:18.13–40:18.73; 66:16.0 → 66:16.3 |
| Player's view cuts away after being hit | 0.3–0.75 s (up to 1.25 s for heavy hits), sometimes followed by a 0.3–0.4 s camera swing back | M 63:43.7–63:44.0; 5:55.33–5:56.00; 40:32.5–40:33.75; 50:12.8–50:13.87 |
| Opponent follow-ups while the player reels | 0.73–0.94 s apart; 0.4–0.6 s in fast runs | M 5:55.33 / 5:56.27 / 5:57.00; 14:26.93 / 14:27.50 / 14:27.87 |
| Player can block again | Within 0.73 s of a hit | M 5:57.73 |

### 2.8 Hit-stop (measured as round-clock stalls)

| Trigger | Stall | Evidence |
|---|---|---|
| Player's ordinary clean hit | 0.13–0.27 s | M: a 0.6 s tick at 10:38.7–10:39.2; S1 ticks of 0.47–0.57 s |
| Player's big clean hit, counter or combo hit | 0.45–0.6 s (median tick 0.80 s vs 0.333 s normal) | M: S7 (50 hits); 1:23.97; 2:56.34; 4:38.77 |
| Knockdown counter | About 0.7 s (a 1.0 s tick) | M 52:12.5–52:13.5 |
| Dodge slow motion | About 0.5–0.9 s | M 4:12.1–4:12.9; 57:14.6–57:15.4 |
| Ordinary hit on the player | None measurable | M: S7 statistics; V 28:25.6 |
| Heavy hit on the player | About 0.45 s | M 5:55.30; 22:22.53–22:23.33 |

### 2.9 Health and the knockdown trigger
- Each fighter has one 10-wedge pie, and partial wedges are drawn (V 59:29.0).
- **There is no regeneration and no top-up between rounds** (V; see C2 and C4). Health only goes back up when a fighter rises from a knockdown (§3.3).
- **A fighter can keep standing on an empty-looking pie.** Seen for 3.2 s (M 25:45.4–25:48.7), about 8 s (M 42:08–42:16.1), and 20 s for an opponent (M 42:23.7–42:45). The player also fought on at 1–2.5 wedges for about 70 s (M 61:01–62:11).
- **A knockdown comes from a clean hit on an empty-looking pie.** A heavy counter can empty the pie and floor the fighter in one blow (M 30:12.93; 28:40.6).
- **Recommended rule (E):** a fighter goes down when a clean hit's damage is at least the health left. Vary per-hit damage by ±30%. That leaves slivers of 0.05–0.4 wedge that read as empty, which reproduces the "empty, then floored on the next hit" pattern. Optional: an ordinary hit never floors a fighter who has more than 1.5 wedges left; leave 0.1 wedge instead, so there is always a warning beat.

### 2.10 Recommended combat constants (E, derived from §2.2–2.9)

| Constant | Value |
|---|---|
| Wedges per pie | 10 (V) |
| Player's ordinary hit | 1.2 wedges, plus 0 to 0.5 for punch speed |
| Player's counter (opponent mid-punch or recovering from a miss) | ×2.5, capped at 4 wedges |
| Opponent's ordinary / heavy hit | 1.1 / 3.0–4.0 wedges |
| Hit-stop: ordinary / big or counter / knockdown blow | 0.2 / 0.5 / 0.7 s |
| Dodge slow motion | World time ×0.25 for 0.75 s after the dodge. Player input stays real-time. (The ×0.25 scale is ESTIMATED.) |
| Player hit cut | 0.35 s ordinary, 0.65 s heavy. The guard pose still counts during the cut. |
| Opponent reel / cover-up / miss recovery | 0.6 / 0.9 / 0.65 s |
| Punch rate limit | 0.2 s per hand and 0.1 s between hands, which allows the observed 5–6 punches/s flurries |
| Regeneration / round top-up / chip damage | 0 / 0 / 0 (V) |

## 3. Knockdowns & KO

### 3.1 Sequence

| Step | Timing | Evidence |
|---|---|---|
| Knockdown blow; the fall plays in the fight view | 0.5–1.2 s | M 24:41.4 → 24:41.8 |
| "Down" call and text | 0.4–1.8 s after the blow (median about 0.9); on screen 0.75–1.0 s | M 11:54.17–11:54.90; 38:03.25 → 38:04.25 |
| First number, "1" | 0.75–1.5 s after "Down" (median about 1.3); 1.3–2.6 s after the blow | M 24:43.58; 36:22.7 |
| Count speed | 1.03–1.10 s per number (median 1.08) | M 11:55.33 … 12:05.13 (mean 1.09); 17:59.84 → 18:09.56 |
| Fighter rises; cut back to the fight view | 0.3–0.5 s after the last number | M: S5 |
| Stand-off, then "Fight!" | 3.3–5.7 s after rising (median about 4.6) | M 13:50.0 → 13:54.5; 30:19.2 → 30:24.0 |
| "Fight!" to the clock running | 0.5–1.3 s | M 42:26.6 → 42:27.85 |
| "10" to "KO" | 1.0–2.0 s (median about 1.3) | M 12:05.13 → 12:06.53; 39:31.0 → 39:32.5 |

- The HUD is hidden and the clock frozen for the whole stoppage. The downed fighter's pie shows as a dark disc, often next to the other fighter's pie (M: 0:52 → 0:50 across 13:38–13:55; V 24:47.0, 42:20.0).
- While the opponent is down, the player's figure keeps mirroring the user's movement (M 40:50–40:52).
- While the player is down, the opponent walks to the far side and waits in guard (M 42:16.65–42:22).

### 3.2 Getting up (opponents)

| Knockdown number in the bout | Times reached | Stayed down (KO) | Count when rising: mean / median / range |
|---|---|---|---|
| 1st | 27 | 5 (19%) | 5.6 / 6 / 3–8 (n = 21) |
| 2nd | 22 | 6 (27%) | 6.7 / 6 / 5–9 (n = 15) |
| 3rd | 16 | 6 (38%) | 8.0 / 8 / 7–9 (n = 9) |
| 4th | 10 | **10 (100%)** | — |

By rating tier:

| Tier | Bouts | KO'd on 1st / 2nd / 3rd knockdown | Mean knockdowns to KO | Mean rise count on 1st knockdown |
|---|---|---|---|---|
| Below 600 | 8 | 4/8, 3/4, 1/1 | 1.6 | 7.0 |
| 600–999 | 6 | 1/6, 1/5, 1/4 | 3.0 | 5.2 |
| 1000 and up (PRO) | 13 | 0/13, 2/13, 4/11 | 3.4 | 5.25 |

Both tables are M, compiled from Appendix A. B27's rise counts are left out because the uploader trimmed them.

- Every opponent who stayed down on a first knockdown had been floored 7–13 s after the bell by a sustained flurry (M: B02 12.9 s, B05 8.7 s, B07 about 10 s, B08 about 9 s, B13 7.3 s).
- B01 was also floored at 9.8 s yet rose at 7. Treat staying down as a random roll weighted by tier, not a fixed rule (E).
- Higher-rated opponents rise **sooner** from a first knockdown (5.2 vs 7.0) and almost never stay down on it (M).

### 3.3 Refill on rising (V)

| Who | After the 1st | After the 2nd | After the 3rd |
|---|---|---|---|
| Opponents | **8/10** (9 of 9 checked) | **6/10** (5 of 6; one read 5 mid-animation) | **4/10** (2 of 2) |
| Player | **8/10** (M 30:20–30:22 at 80–83%; 42:24; 62:19) | **6/10** (M 31:03–31:05 at 57–64%) | Never reached |

- **The rule (V fit): refill = 10 − 2 × the knockdown number, in wedges.**
- It does not depend on the count reached: first-knockdown rises at counts 3 through 8 all came back at 8/10 (V).
- The refill shows as a glowing sweep with sparkles over about 1–1.5 s after the fighter stands (M 67:48.4–67:50.0).
- Frames checked (V):
  - After a 1st knockdown: 4:29.7, 6:15.3, 8:46.7, 17:14.0, 19:13.7, 28:48.8, 38:13.3, 44:49.8, 56:45.1
  - After a 2nd: 13:52.0, 17:45.5, 34:32.3, 57:25.5, 61:16.3 (read 5, mid-animation), 68:46.0
  - After a 3rd: 31:48.3, 61:49.5

### 3.4 KO, TKO and limits
- A KO means still being down at "10". Every KO in the footage was a full count (M ×27).
- **There is no three-knockdown TKO.** Fighters survived three knockdowns in one round (M):
  - B22, round 1: down at clock 2:10, 0:46 and 0:05, and kept fighting.
  - B11, round 1: down at 19:01.7, 19:32.4 and 20:22.5, then a KO on the 4th at 20:49.5, still in round 1.
- **A 4th knockdown was always a KO** (M, 10 of 10). Make it a rule that nobody rises from a 4th knockdown (E). Under the 10 − 2k refill rule it would only give back 2 wedges anyway.
- A KO ends the bout at once, in any round (M: 27:16 in round 2 at 2:37; 32:07.5 in round 3).

### 3.5 Player knockdowns
- The player was knocked down 10 times across 8 bouts (B09, B11, B14, B15 twice, B16, B18, B24, B27 twice). None became a KO.
- The player rose at **4** in 7 of 9 visible cases and at 6 in two: B15's second (30:54.5 → 31:03) and B27's first (rose after "6" at 70:55.0, V). B27's second knockdown was trimmed by the uploader.
- No get-up prompt or meter appears on screen, and the input used to get up isn't visible in the footage (M 14:35–14:40.5; 42:16.65–42:22.2).
- The usual cause was a heavy counter, or a body shot under a high guard, at 0–2 wedges (M 30:12.93; 42:16.13; 62:11.86; 70:52.4).
- Camera: a low shot with the player face-down in the foreground and the opponent waiting upright at the far side (M 42:17; V 42:20.0).

### 3.6 Recommended implementation (E)
- **Opponent, on each knockdown:** roll that opponent's stay-down chance for this knockdown number (§4.5). If it rises, draw the count from a normal distribution around its mean with SD 1.2, clamped to 3–9. A 4th knockdown always stays down.
- **Player:** rising is earned during the count by pumping, i.e. throwing alternating punches to fill a meter.
  - Suggested: 8, 12 and 16 punches for knockdowns 1, 2 and 3.
  - The earliest possible rise is at counts 4, 5 and 7.
  - If the meter isn't full by "10", it's a KO.
  - This matches the observed pattern of rising at 4.
- **Both fighters** use the 1.08 s count, the 10 − 2k refill, and the stoppage of about 8.1 s + 0.92 s × the count reached.

## 4. Opponent AI

### 4.1 Behavior shared by all opponents (M)
1. Walks in during "Fight!".
   - Aggressive opponents punch 0.33–1.0 s after the clock starts (2:46.70; 4:01.50; 5:47.57; 49:49.2).
   - Others wait 2.3–7.6 s (25:30.5; 18:56.5).
2. Bobs in place between attacks with both gloves high. A few low-rated opponents keep their gloves low or open (B05 at 7:35.57; B08 made 0 blocks in 8.4 s).
3. Attacks with single punches, one-twos and strings of 3–4, mixing head and body. Ordinary punches have short tells (§4.3).
4. Punishes in four ways:
   - countering after blocking: 0.2–0.82 s from the green ring to impact;
   - countering the player's miss;
   - slipping, then countering 0.2–0.3 s later;
   - punching into the player's punch, landing 0.1–0.2 s after it starts.
5. Keeps hitting while the player reels, 0.4–0.94 s between hits.
6. Covers up with a high guard for about 0.9–1.0 s after taking two quick hits (50:11.4–50:12.3).
7. Holds a cocked punch for up to 1.0 s while the player is leaning (33:57.93 → 33:59.0).
8. Never gets groggy: keeps guarding and punching at 0 health (42:23–42:45).
9. Changes mood between rounds. One opponent stayed defensive in round 1, then landed 9 hits in 16 s at the start of round 2 (65:18.3–65:34.3).

### 4.2 Measured behavior by tier (M)

In all, 25 distinct opponents rated 118–1612 appeared across the 27 bouts (two were rematches). This table summarizes them by tier.

| Tier (rating) | Bouts | Attack pattern | Hits landed on the player per live minute | Share of player punches blocked | Block → counter delay | Slips | Median live time to the 1st knockdown | Mean knockdowns to KO |
|---|---|---|---|---|---|---|---|---|
| Below 600 | B01–B08 | Single punches and one-twos (0.34–0.6 s apart); one 4-punch string (0.73–0.94 s apart); two opponents never guarded | About 4 (range 0–14) | 0–54% | Rarely counters | None | About 11 s (8.7–17.2) | 1.6 |
| 600–999 | B09–B13, B16 | Counter-punching and bursts: runs of 2–3 hits 0.4–0.9 s apart, and low punches under a high guard | About 8 (0–13) | 58–67% | 0.2–0.82 s | About 1 every 1–2 min | About 24 s (7.3–63) | 3.0 |
| 1000 and up (PRO) | B14–B15, B17–B27 | High guard; punishes nearly every blocked or missed punch; one-twos 0.33 s apart; power hooks for 2.5–4 wedges; head/body mixups | About 7.4 (2–12) | 33–75% | 0.23–0.7 s (median about 0.43) | About 1 every 1–2 min | About 29 s (19.4–61) | 3.4 |

Per-bout values are in Appendix A and the slice logs. The slices counted blocks in different ways, so treat the block shares as ranges.

### 4.3 Tells and timing

| Action | First visible movement → impact | Evidence |
|---|---|---|
| Ordinary jab or straight | 0.17–0.3 s: a tuck or draw of 0.1–0.2 s, then 0.07–0.13 s of travel | M 2:48.45 → 2:48.68; 18:56.27 → 18:56.53; 54:16.53 → 54:16.70; 25:48.4 → 25:48.7 |
| Step-in body punch | 0.45 s: step 0.2 s, cocked 0.17 s, strike 0.07–0.1 s | M 8:55.78 → 8:56.22 |
| Low punch under a high guard | 0.13–0.3 s | M 13:20.57 → 13:20.70; 62:11.56 → 62:11.86; 63:43.4 → 63:43.7 |
| Counter after a slip | 0.2–0.3 s of travel | M 12:43.12 → 12:43.42; 33:24.83 → 33:25.03; 30:05.23 → 30:05.5 |
| Power hook with the glove raised | 0.4–0.8 s: held 0.5–0.57 s, then a 0.23 s swing | M 37:43.23 → 37:44.03; 40:35.33 → 40:35.87; 30:37.7 → 30:38.1 |
| Long power punch with a red trail | 0.6–0.7 s of travel | M 47:57.53–47:58.13; 51:41.8–51:42.53 |
| Punch cocked and held while the player leans | Up to 1.0 s | M 33:57.93 → 33:59.0 |
| Gap between punches in a combo | 0.33–0.45 s when fast, 0.6–0.94 s when slow | M 28:25.63 / 28:25.97; 34:06.47 / 34:06.8 / 34:07.2; 2:54.30 → 2:54.90; 5:55.33 → 5:57.73 |
| Block → counter impact | 0.20–0.82 s (median about 0.43) | M 16:52.27 → 16:52.47; 37:56.20 → 37:56.43; 42:15.73 → 42:16.13; 50:12.33 → 50:12.80; 59:27.13 → 59:27.76; 44:25.67 → 44:26.37; 12:57.73 → 12:58.55 |
| Punch into the player's punch | Lands 0.1–0.2 s after the player's jab | M 57:04.35 → 57:04.58 |

### 4.4 How difficulty ramps (M), strongest effect first
1. **KO resistance.** The chance of a KO on the first knockdown falls from 50% to 0%, and the knockdowns needed for a KO rise from 1.6 to 3.4 (§3.2).
2. **Guard and punishment.** Below 600 a blocked punch is rarely punished. At 1000 and up it nearly always is, 0.23–0.7 s later.
3. **Telegraphed power punches and low punches aimed under a high guard.** These appear from about rating 700 (from B09; e.g. 13:20.63).
4. **Combo speed.** Gaps of 0.6–0.94 s at ratings 139–367 shrink to 0.33–0.45 s in fast combos at 520 and up.
5. **Aggression.** About 4 hits per minute below 600, and 7–8 per minute above, with peaks of 12–13.

Two things that do not ramp much:
- **Tells barely get shorter.** 0.23 s at r139 vs 0.17–0.3 s at r1425–1612. Defense is mostly about keeping the guard up, not reacting to long wind-ups (M; S2's conclusion).
- **Rating only loosely predicts difficulty.** B05 (r410) and B13 (r922) barely attacked, while B27 (r1572, rated below the player) was the only opponent to knock the player down twice (M).

### 4.5 Recommended roster of 10 original opponents (E)

Each opponent below is a fighting style built from measured reference bouts, which are listed in brackets. Names, looks and personalities are Glove Up's own.

**a) Offense**

| # | Rating | Style [reference bouts] | First attack after "Fight!" (s) | Gap between attacks (s) | Ordinary tell (s) | Punches per attack (weights %) | Gap between punches in an attack (s) | Body % | Power % | Power tell (s) | Power damage | Ordinary damage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 120 | Sparring partner [B01, B05, B07] | 2.0 | 7.0 | 0.45 | 1 (100) | – | 20 | 0 | – | – | 1.0 |
| 2 | 280 | Bell rusher [B02, B03] | 0.4 | 3.5 | 0.25 | 1–2 (60/40) | 0.60 | 25 | 0 | – | – | 1.0 |
| 3 | 450 | String puncher [B04] | 0.7 | 3.5 | 0.30 | 1–4 (40/30/20/10) | 0.75 | 30 | 10 | 0.60 | 2.0 | 1.0 (first punch 1.5) |
| 4 | 600 | Quick one-two, head and body [B06, B08] | 0.7 | 3.0 | 0.30 (body 0.45) | 1–2 (50/50) | 0.40 | 40 | 10 | 0.60 | 2.0 | 1.0 |
| 5 | 750 | Counter-puncher [B09, B10, B12] | 1.0 | 3.0 | 0.25 | 1–3 (40/40/20) | 0.50 (0.80 on a reeling player) | 35 | 15 | 0.55 | 2.5 | 1.1 |
| 6 | 900 | Patient power puncher [B11, B16] | 3.0 | 3.5 | 0.25 (holds up to 1.0 while you lean) | 1–3 (50/25/25) | 0.35 | 30 | 20 | 0.60 | 2.5 | 1.0 |
| 7 | 1050 | Fortress [B14/B15, B17, B22] | 2.4 | 2.5 | 0.22 | 1–2 (50/50) | 0.33 (head then body: 0.90) | 30 | 20 | 0.80 (raised glove) | 4.0 | 1.1 |
| 8 | 1200 | Body hunter [B18, B19] | 1.5 | 2.5 | 0.23 | 1–2 (60/40) | 0.50 | 60 | 30 | 0.53 | 3.0 | 1.2 |
| 9 | 1400 | Rusher [B20, B21, B23] | 0.6 | 2.2 | 0.20 | 1–2 (50/50) | 0.55 | 40 | 25 | 0.70 (long trail) | 3.0 | 1.1 |
| 10 | 1600 | Champion [B24–B27] | 0.6 | 3.5 in round 1, 1.6 after | 0.18 | 1–3 (40/40/20) | 0.40–0.90 | 40 | 25 | 0.45 (wide hook) | 3.5 | 1.1 |

**b) Defense and KO**

| # | Head guard | Body guard | Slip % (counter delay, s) | Punish % (delay, s) | Punch-into % | Cover-up % | Reel (s) | Miss recovery (s) | Stays down on knockdown 1 / 2 / 3 | Mean rise count on knockdown 1 / 2 / 3 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0.15 | 0.05 | 0 | 0 | 0 | 0 | 0.70 | 0.80 | 0.40 / 0.80 / 1.0 | 7 / 8 / 9 |
| 2 | 0.35 | 0.10 | 0 | 15 (0.6) | 0 | 20 | 0.65 | 0.70 | 0.45 / 0.75 / 1.0 | 7.5 / 8 / 9 |
| 3 | 0.45 | 0.15 | 0 | 25 (0.6) | 0 | 30 | 0.60 | 0.70 | 0.35 / 0.60 / 1.0 | 7 / 7.5 / 8.5 |
| 4 | 0.50 | 0.20 | 1 (0.3) | 30 (0.6) | 0 | 30 | 0.60 | 0.70 | 0.30 / 0.50 / 0.60 | 6 / 7 / 8 |
| 5 | 0.62 | 0.25 | 2 (0.3) | 60 (0.4–0.8) | 0 | 40 | 0.55 | 0.65 | 0.15 / 0.20 / 0.25 | 5 / 6.5 / 8 |
| 6 | 0.55 | 0.20 | 2 (0.2) | 45 (0.5) | 0 | 40 | 0.55 | 0.65 | 0.10 / 0.20 / 0.25 | 5.5 / 6 / 8 |
| 7 | 0.72 | 0.30 | 3 (0.27) | 85 (0.23–0.6) | 0 | 50 | 0.50 | 0.60 | 0 / 0.17 / 0.40 | 5 / 7 / 8 |
| 8 | 0.60 | 0.30 | 3 (0.25) | 70 (0.4–0.7) | 0 | 40 | 0.55 | 0.60 | 0 / 0.10 / 0.35 | 6 / 8 / 8 |
| 9 | 0.65 | 0.30 | 2 (0.25) | 75 (0.47) | 8 | 60 | 0.50 | 0.65 | 0 / 0.15 / 0.40 | 5 / 6 / 8.5 |
| 10 | 0.65 | 0.35 | 3 (0.2–0.3) | 85 (0.40) | 5 | 50 | 0.50 | 0.50 | 0 / 0.10 / 0.40 | 6 / 7.5 / 8 |

What the columns mean:
- **Head guard / Body guard:** the chance that a player punch at that height meets the guard while the opponent is idle, i.e. not reeling and not attacking.
- **Slip %:** the chance, per head punch, that the opponent slips it and then counters after the given delay.
- **Punish %:** the chance of a counter after blocking, with the delay from the green ring to impact.
- **Punch-into %:** the chance of punching into the player's punch, landing 0.1–0.2 s after it starts.
- **Cover-up %:** the chance of holding a high guard for 0.9 s after taking 2 hits within 1 s.
- **Stays down:** the chance of staying down on knockdowns 1–3. A 4th knockdown always stays down.

**c) Tuning targets**

Playtest until each opponent lands in these ranges, which are taken from the measured tiers.

| # | Live s to the opponent's 1st knockdown | Opponent hits on the player per minute | Share of player punches blocked | Knockdowns to KO | Usual ending |
|---|---|---|---|---|---|
| 1 | 9–13 | 0–4 | 0–20% | 1–2 | Round 1 |
| 2 | 12–17 | 4–5 | 30–45% | 1–2 | Round 1 |
| 3 | 12–18 | 8–9 | 35–50% | 2 | Round 1 |
| 4 | 10–15 | 6–9 | 45–55% | 1–3 | Round 1 |
| 5 | 20–30 | 7–9 | 58–67% | 3–4 | Round 1–2 |
| 6 | 13–31 | 8–13 | 50–60% | 3–4 | Round 1–2 |
| 7 | 25–60 | 7–10 | 60–75% | 2–4 | Round 2, sometimes 3 |
| 8 | 25–40 | 5–7, heavy | 50–60% | 3–4 | Round 2 |
| 9 | 20–40 | 8–10 | 40–60% | 2–4 | Round 2 |
| 10 | 21–33 | 9–12 | 35–50% | 3–4 | Round 2 |

**d) The game's roster against these E values (repair round, then the polish round)**

`src/game/roster.js` deviates from a) and b) so that `node dev/sim.mjs`, which runs on the renderer's hit-stop clock (§2.8) with a webcam bot that registers punches at full extension, lands the skilled 'player' bot in c). Since the repair round the tuning is two-sided: two weaker bots keep win floors, so the PRO tier stays beatable — 'casual' (a first-timer) wins at least 90 % against #1–#4, at least 25 % against each of #5–#9 and, since the polish round (decision R9: the champion hits as hard as a) says), at least 15 % against #10, and 'mid' (every knob halfway between 'casual' and 'player') at least 55 % against #7 and #8. The roster.js header gives the reasons for each value.

Deviations from a) and b) after the polish round:
- #5: head guard 0.94 (repair round 0.95).
- #7: head guard 0.92, body guard 0.35, punishes landing 0.28–0.65 s after the green ring, cover-up 0.5, ordinary damage 1.0, attack gap 3.1 s.
- #8: head guard 0.74, body guard 0.38, cover-up 0.6, flurry guard 0.4, attack gap 7.6 s (it lands most of its hits as punishes, at the b) punish rate).
- #9: attack gap 5.1 s (repair round 5.6; likewise); head guard 0.69 (repair round 0.72); its other glove covers 0.85 of reads while it punches (0.7 before).
- #10: head guard 0.5; cover-up 0.5 (= b); punishes landing 0.40–0.60 s after the ring. Since the polish round (R9) its damage is a)'s again (25 % power at 3.5, ordinary 1.1; the repair round had 20 % at 3.0 / 1.0), with gaps of 3.8 s in round 1 and 1.7 s after (a) 3.5 / 1.6; with a)'s exact gaps a first-timer won only 14.5–19 %).
- Every opponent punishes at most once per blocked exchange (a flurry into the guard is one exchange) at the b) rates, thrown 0.2–0.82 s after the ring as measured, and a punish that can only start late keeps the opponent's own tell. Against a held dodge posture every blocked punch may be punished.
- Not in the footage (our own design; the polish round's answer to degenerate keyboard play, R10): from #5 up, a player who keeps punching into the guard (blocked again within 1 s of a green ring, on a steady beat, or mashing with a guard shown between quick punches) has the next punch caught and countered 0.17–0.23 s after it starts, while the glove is out (§2.4); nothing shows before, and no punish is thrown if no punch comes. The body read follows a player who goes to the body most of the time (toward the head read; the gloves then rest low).
- Not in the footage (our own design): an opponent answers a dodge posture held for about 1 s, or one the player keeps bobbing back into, with a punch that posture does not evade. Only a dodge made as the punch comes earns the slow motion and a counter (§2.5). Dipping into postures with no attack coming (twice or more in 6 s) is bobbing, and those dodges earn neither. During a clear sideways lean the head counts as ducked only below −(0.42 + 0.25·|lean.x|), because a webcam slip dips the head a little.
- Per-hit guard-open spans after an ordinary or a heavy hit, as in the fix pass.

Win rates, repair round → polish round (n = 200 per cell; seeds 1 / 7 / 3):

| Bot against | Repair round | Polish round |
|---|---|---|
| casual vs #1–#4 | 92–100 % | 92–100 % |
| casual vs #5 | 39 / 43 / 42 % | 44 / 45 / 44 % |
| casual vs #6 | 87 / 77 / 82 % | 87 / 77 / 82 % |
| casual vs #7 | 30 / 28 / 31 % | 28 / 29 / 32 % |
| casual vs #8 | 34 / 37 / 38 % | 33 / 37 / 39 % |
| casual vs #9 | 29 / 35 / 34 % | 32 / 28 / 29 % |
| casual vs #10 | 29 / 31 / 27 % | 20 / 24 / 20 % |
| mid vs #7 | 79 / 70 / 64 % | 76 / 70 / 64 % |
| mid vs #8 | 63 / 59 / 60 % | 61 / 63 / 56 % |
| player vs #7–#10, wins | 93–99 % | 90–100 % |
| player vs #7–#10, floored at least once | 50–82 % | 54–85 % |

(The fix pass's column is in the repair round's version of this table: casual vs #7 6 / 5 / 2 %, vs #10 15 / 19 / 27 %.)

Degenerate keyboard play (R10; the real keyboard module on the hit-stop clock; win % / floored %, repair round (24 bouts a cell) → polish round (48 bouts a cell), seeds 9301 + 97 i + 7 × tier):

| Strategy | #5 | #6 | #7 | #8 | #9 | #10 |
|---|---|---|---|---|---|---|
| Space + J/K every 0.6 s | 50/88 → 4/100 | 100/21 → 0/100 | 63/100 → 0/100 | 38/100 → 0/100 | 100/46 → 0/100 | 88/100 → 0/100 |
| Space + Shift (body) + J/K every 0.6 s | 100/8 → 4/100 | 100/0 → 4/98 | 100/4 → 0/100 | 100/17 → 0/100 | 100/0 → 0/100 | 100/8 → 0/100 |
| Space + J/K, head and body in turn, every 0.6 s | 100/50 → 4/100 | 100/0 → 4/100 | 100/29 → 0/100 | 100/75 → 0/100 | 100/17 → 0/100 | 100/33 → 0/100 |
| S + B, J/K every 0.6 s | 46/96 → 2/98 | 96/88 → 2/98 | 8/100 → 0/100 | 4/100 → 0/100 | 17/100 → 2/100 | 50/100 → 0/100 |
| A + S + X + B, J/K every 0.6 s | 50/92 → 2/98 | 96/88 → 2/98 | 33/100 → 0/100 | 8/100 → 0/100 | 17/100 → 0/100 | 50/100 → 0/100 |
| S + B pulsed 1.1 s / 0.5 s, a tap after each dodge | 100/25 → 0/100 | 92/79 → 0/100 | 100/79 → 0/100 | 71/58 → 0/100 | 100/63 → 0/100 | 54/96 → 0/100 |
| S + B pulsed 0.5 s / 0.9 s, a tap after each dodge | 100/63 → 2/100 | 17/100 → 0/100 | 21/100 → 0/100 | 8/88 → 0/100 | 25/96 → 0/100 | 8/100 → 0/100 |
| Space + J/K every 1.2 s | 33/100 → 13/98 | 96/83 → 54/96 | 58/100 → 4/100 | 83/100 → 0/100 | 92/96 → 13/100 | 83/100 → 6/100 |
| Space + J/K every 2 s (no mashing; open) | 21/92 → 29/94 | 83/96 → 73/96 | 21/100 → 23/100 | 50/100 → 50/98 | 54/100 → 56/98 | 46/100 → 23/100 |
| casual (the bound is this + 10) | 41 → 44 | 82 → 82 | 30 → 29 | 36 → 36 | 32 → 30 | 29 → 21 |

Above the bound (casual + 10 points, or floored < 30 % against #8–#10), 145 strategies × 6 opponents (guard, body and mixed mashing every 0.45–2 s or at random gaps; single and combined postures plus a guard with taps or mashing; pulse turtles with dips of 0.35–1.3 s): repair round 301 cells (24 bouts, seed 9301). Polish round, 48 bouts: 2 cells at seed 9301 and 1 at seed 9701, all the 2 s jab against #8 / #9. The tightest mashing cell is Space + Shift + J/K every 1.2 s against #6, 83–88 % (bound 92 %).

'player' against c), repair round → polish round (n = 200, seed 1; live s to the opponent's 1st knockdown / opponent hits on the player per minute / share of player punches blocked / knockdowns to KO; * = outside c)):

| # | Repair round | Polish round |
|---|---|---|
| 1 | 8.1* / 2.5 / 20 %* / 1.8 | 8.1* / 2.5 / 20 %* / 1.8 |
| 2 | 12.2 / 5.5* / 42 % / 1.7 | 12.2 / 5.5* / 42 % / 1.7 |
| 3 | 13.1 / 8.2 / 49 % / 2.0* | 13.1 / 8.2 / 49 % / 2.0* |
| 4 | 14.1 / 8.5 / 47 % / 2.3 | 14.1 / 8.5 / 47 % / 2.3 |
| 5 | 19.8* / 8.0 / 67 % / 3.1 | 20.3 / 8.0 / 66 % / 3.1 |
| 6 | 14.6 / 8.1 / 52 % / 3.3 | 14.9 / 8.2 / 51 % / 3.3 |
| 7 | 19.1* / 7.6 / 62 % / 3.3 | 20.1* / 7.5 / 62 % / 3.3 |
| 8 | 19.5* / 7.3* / 60 %* / 3.5 | 19.7* / 7.4* / 60 %* / 3.5 |
| 9 | 21.4 / 8.3 / 60 %* / 3.3 | 21.7 / 8.7 / 59 % / 3.4 |
| 10 | 21.2 / 10.4 / 57 %* / 3.5 | 21.2 / 9.8 / 58 %* / 3.4 |

Residual misses for 'player': 9 / 8 / 9 of the 40 cells at seeds 1 / 7 / 3 (repair round 11 / 9 / 11): #1 first knockdown 8.0–8.2 s (target 9–13; it still finishes in round 1 after 1.7–1.8 knockdowns) and 20.5 % blocked at seed 1; #2 5.5–5.6 hits per minute; #3 1.9–2.0 knockdowns to KO and 7.8 hits per minute at seed 3; #7 and #8 first knockdown about 18–22 s (25+); #8 7.3–7.4 hits per minute and 60–62 % blocked; #10 58–59 % blocked.

### 4.6 Keeping it fair on a webcam (E)
- A person's simple reaction time is about 0.2–0.25 s, and a webcam plus MediaPipe adds about 70–150 ms on top.
- Ordinary tells (0.17–0.3 s) couldn't be reacted to in the reference either; that design relies on keeping the guard up. Keep them as measured.
- Power-punch tells (0.4–0.8 s) are the moments the player is meant to see and dodge. Keep them at 0.55 s or more, plus the measured input latency.
- Check a guard or dodge against the player's pose at impact time minus the measured latency. Otherwise a block that looked good on screen will lose.
- Measure end-to-end latency per device during calibration and store it.

## 5. Information on screen (function only)

| Element | Purpose | Behavior and timing | Evidence |
|---|---|---|---|
| Round clock box (bottom center, about 43–57% of screen width, 79–95% of height) | Time left and which round it is | Three lamps (done / current / future) above an M:SS countdown from 3:00. The first visible reading is 2:59 or 2:58. Ticks every 0.333 s and stalls on big hits. Hidden during intros, knockdowns, breaks and replays. Stays up during the player-hit cut. | M 22:19.53; 28:16; V 28:25.6 |
| Name plates (bottom corners) | Who is who | Small face icon, name and a colored underline: player in blue on the left, opponent in grey on the right. Static; they are not health bars. | M: same length at 18:49.5 and at 20:08 |
| Opponent's health pie | Opponent's damage | 10 red wedges floating beside the opponent's head (about 64–69% across, 22–30% down; diameter about 7% of screen width). Anchored to the fighter in 3D. Drains clockwise from 12 o'clock. | V 1:17.5, 18:50.4; M S1 |
| Player's health pie | Player's own damage | 10 blue wedges at left-center near the lead glove (about 25–32% across, 58–65% down; diameter about 9% of screen width). | V 16:53.0, 59:28.1 |
| Pie behavior, both pies | Show damage without a permanent bar | See the list below this table. | M 5:47.7 → 5:50.2; 59:27.6 → 59:31.1; 67:38.9; V 16:52.5–16:54.4, 34:16–34:39 |
| Hit vocabulary | Instant read of every exchange | Pink starburst: your clean hit (bigger for a counter). Green ring: any block. Orange radial lines, a camera cut and a blue/white burst: you were hit. Purple burst: a heavy hit or counter on you. Red trail: the path of the opponent's power punch or hook, also its miss streak. Blue trail: your fast punch. | M, all slices |
| Text calls | Phase changes | See the list below this table. | M 44:09; 49:47.53; 11:54.17; 36:22.7; 39:32.5 |
| VS card | The matchup and the stakes | Both fighters, split by a diagonal energy bolt. Each side shows rating, name, and a PRO badge if rated 1000 or more. A confirm prompt. Also 4 small pips with one lit, likely a player-slot indicator; a webcam game doesn't need it (E). | M 25:20; 32:59; 59:05.5 |
| Results card | Progress | A line graph of rating history with a horizontal PRO line at 1000. The new rating, the signed change and an up or down arrow. "Play again" (the default) and "Quit" appear 1–2.5 s later. | M 2:33.5; 28:05.6 (+48); 32:56.8 (−4) |
| Never shown | — | Numeric damage, combo counter, score, punch stats, stamina, knockdown tally, judges' cards | M, all slices |

**How a pie behaves**
- It appears only when its fighter is hit.
- It first shows the pre-hit value, then drains 0.5–0.8 s later.
- The lost part breaks into white shards with a ring pulse.
- Up to one wedge on the lost side of the edge blinks at 10 Hz (1 frame lit, 2 dark at 30 fps) for as long as the pie is visible.
- It hides 2.5–4 s after the last hit, but stays up while the fighter has about 3 wedges or fewer, or is empty.
- During a count it shows as a dark disc.
- On rising it refills with a glowing sweep and sparkles (about 1–1.5 s).
- It flashes and bursts when the knockdown hit lands.

**Text calls**
- "Round N" or final-round banner: 1.5–2.5 s.
- "Fight!": 0.75–1 s, at every round start and every restart.
- "Down": 0.75–1 s; two halves sweep in and merge.
- Numbers 1–10: one every 1.08 s, each visible about 0.5 s, with a pop, scale and fade.
- "KO": the letters fly in and bounce for about 1.5 s.
- Win banner with confetti: 3–5 s.
- A "Replay" tag at the bottom left during replays.

## 6. Camera & presentation

| Moment | Camera | Duration | Evidence |
|---|---|---|---|
| Live fight | Just behind the player's head, at about head height and slightly to one side: the player's own see-through head sits high in the frame beside the opponent's head, the solid gloves mid-frame. The player's body is about 50% transparent; the gloves are solid. The opponent is seen whole (head to feet), near the centre. The view orbits slowly as the fighters circle (a corner post crosses the frame in about 20 s). | — | M S4; V 59:28.1 |
| Lean or dodge | The view slides sideways about 1/4–1/3 of the screen width. A successful dodge adds smeared slow motion. | Slide 0.15 s or less; slow motion about 0.5–0.9 s | M 56:20.93; 4:12.1–4:12.9 |
| Player lands a hit | No cut: a burst, a head snap and hit-stop | 0.15–0.6 s | M S1–S8 |
| Player gets hit | One frame of orange radial lines, a hard cut to a tight, solid over-the-shoulder shot with a burst, then a hard cut back (sometimes a 0.3–0.4 s camera swing back) | 0.3–0.75 s (up to 1.25 s for heavy hits) | V 28:25.59–28:26.02; M 40:32.5–40:33.75 |
| Opponent knocked down | The fall plays in the fight view, then a cut to a high, wide shot from behind the standing player, looking down at the opponent on the canvas. The count numbers are overlaid. | The fall takes 0.5–1.2 s | V 19:06.0, 24:47.0 |
| Player knocked down | A low shot: the player face-down in the foreground, the opponent waiting upright at the far side | — | V 42:20.0 |
| Getting up | Cut back to the fight view facing the fighter who rose; a stand-off; "Fight!" | 4–5 s | M 13:50.0 → 13:54.5 |
| Round change | Fade to a high, wide arena shot; the banner sweeps through; a ring-level shot of both fighters; a close-up from behind the player; "Fight!" | 7.8–10 s in total | M 34:39.6 → 34:48.8 |
| Bout intro | VS card, arena shot, round banner, fly-in, "Fight!" | 7–10 s | M 44:06 → 44:14.4 |
| KO outro | See the list below this table. | 33–58 s until the next "Fight!" | M 36:37–36:45; 2:01–2:35 |

**KO outro, in order**
1. "KO"
2. Logo wipe
3. White flash
4. Slow-motion replay from side, low and overhead angles, ending on the final blow. The fall takes about 3 s in the replay vs 0.5–0.6 s live.
5. White fade
6. Win banner with confetti and light streaks
7. The winner faces the camera with the beaten opponent behind
8. Results card

**Slow motion** appears in two places:
- The dodge window during play (§2.5).
- The KO replay, at roughly 0.2× on the final blow (E, from the 3 s vs 0.5–0.6 s fall).

In live play the KO blow itself only gets about 0.7 s of hit-stop (M 52:12.5–52:13.5).

**Other presentation details**
- **No referee** is drawn. The count is shown as numbers with a voice (V; see C12).
- **The crowd** fills tiered stands all around the ring. It reacts to hits, swells on knockdowns and roars on a KO. Arena boards show flavor taunts that carry no gameplay information (M 18:00–27:00; 34:00).
- **Transitions:** hard cuts during play, crossfades between rounds, white flashes and a brand wipe around the replay, and about 0.5 s of black between the results card and the next VS card (M 44:05).

**Audio cue moments.** These describe when a sound plays, not what it sounds like. Make every sound original.
- A spoken round call 3.5–4 s before "Fight!" (M 25:24.46 → 25:27.94)
- A bell on every "Fight!", at round starts and restarts (M 55:21.95; 58:00.70)
- A bell at 0:00 (M 34:39.6; 26:57.7)
- A separate tone under the "Round N" banner (M 55:18.0)
- A spoken "Down" with the text
- One count call per number, every 1.08 s
- A heavier hit sound on "KO", and a crowd roar about 1.8 s after "10"
- Distinct sounds for a clean hit, a block and a counter (M: read from the S3, S4 and S7 waveforms)

## 7. Progression

### 7.1 Rating changes after wins (M, Appendix A)
- **Clean KO win** (the player was never knocked down; n = 19).
  - The gain is +75 at rating 0 and falls slowly to +63 at 1541. Fit: **Δ ≈ 75 − R/135**, where R is the player's rating before the bout (max error about 3).
  - The round of the KO made no difference: +71 for a round-1 KO at 816, +70 for a round-2 KO at 746.
- **Player knocked down once** (n = 6): the gain was 15–38 below the clean-win value (median −21). Actual gains: +33, +52, +48, +47, +53, +38.
- **Player knocked down twice:** +10 in B27, against a lower-rated opponent. −4 in B15, which also went to round 3. So a KO win can lose rating.
- **Heavy damage without a knockdown barely counts.** In B21 the player was drained to about 1/10 and still got +64, against about 66 expected.
- **Losses** never happened in the footage.

### 7.2 Matchmaking (M)
- **The game picks each next opponent 50–148 above the player's rating** (mean +100, n = 26).
- The only exception: at 1656 the player got a 1572 opponent (−84) and earned just +10. This suggests the opponent pool tops out around 1600 (E).
- **Rematches happen.** Twice, "Play again" offered the opponent just beaten, at a higher rating: B14 (r1017) → B15 (r1025), and B24 (r1487) → B25 (r1612).

### 7.3 PRO
- The results graph has a horizontal **PRO line at 1000**. A PRO badge shows on the VS and results cards for anyone rated 1000 or more (M: 25:20, r1017 with a badge; 32:59, r981 without; 39:57, the player at 1047 with a badge).

### 7.4 Rewards
- The only reward is rating, plus one cosmetic. The player's gloves changed color between 69:57 (rating 1604) and 70:12 (rating 1656). The bout in between was cut by the uploader, so what unlocked it is unknown (M 70:12).

### 7.5 Recommended for Glove Up (E)
- **Win:** `Δ = round(75 − R/135) − 20·[knocked down ≥1] − 35·[knocked down ≥2] − 10·[went to round 3]`, with a minimum of −10. This stays within about 18 of every observed result.
- **Loss** (never observed): −40 for a KO, −25 for a decision.
- **PRO** at 1000, and losable, as in spec.md PRG02.
- **With only 10 opponents:**
  - Give each opponent a base rating from §4.5.
  - After the player beats an opponent, raise that opponent's rating by 60–125 for rematches, as the reference did (1017 → 1025 and 1487 → 1612).
  - Offer the next unbeaten opponent once it is rated within 150 of the player. Otherwise offer the beaten opponent rated closest to the player's + 100 within +50…+150 (the measured band, §7.2), not one met in the last two bouts while another fits. Cap a beaten opponent's raised rating at the next rung's base + 100 (the champion at its base + 125).
  - If nothing fits, offer the nearest fit. Once the player has out-climbed everyone, the top three take turns, the champion first (like the reference's 1572 opponent at 1656).
  - (Revised in the fix pass, RULES-04: the earlier "within 200 / highest-rated rematch ≥ R + 50 / highest available" rule locked careers onto one opponent.)
  - At about +70 per win, getting from 0 to about 1700 takes roughly 25 wins, about the length of this playthrough.
- **Cosmetics:** unlock new glove colors at rating milestones, for example 1000 and 1600.

## 8. Training modes
- **No training modes appear in the footage**: no bag, dodge or mitt drills, and no fitness test. The fitness check is out of scope at the user's request. spec.md lists training drills, but there is no footage of them to measure.
- **A tutorial is built into the first bout** (M 0:10–1:13).
  - It runs live against the first opponent, with no clock and no pies.
  - Six cards of about 8–10 s each, with 1–2 s gaps:
    1. Stance (0:12–0:20)
    2. Guard face (0:22–0:31)
    3. Punch face (0:32–0:41; about 7 face hits landed)
    4. Guard body (0:42–0:50)
    5. Punch body (0:52–1:00; about 9 body hits, about 0.75 s apart)
    6. Dodge (1:02–1:10)
  - "Fight!" follows at about 1:13 and the clock starts.
- **Card layout:** a framed panel at the lower left, directly above a 2-line caption band along the bottom, with the step title and a pictogram of the pose (M 0:15–1:05).
- **Recommended (E):** keep the six steps, but advance each one when the pose is held, or the action is detected 3 times, with a 10 s cap, rather than on a timer. Fold webcam calibration into the stance step.

## 9. Open questions / not observed

This file also answers the spec.md §9 items that the footage covers:
- clock during interruptions: §1.4 and §3.1
- recovery and health restoration: §3.3
- repeated knockdowns: §3.4
- damage, guard coverage and counter timing: §2
- rating formula and opponent selection: §7
- cosmetic unlocks: §7.4

Still open:

1. **Decisions.** No bout went the distance (0 of 27), so scoring, the judges' display and draw rules are unknown. Proposal (E): score each round 10–9 for the better fighter, take a point off per knockdown, and break ties on clean hits.
2. **Losing.** The player never lost. Unknown: the loss screen, the rating penalty, and whether a 4th player knockdown is also an automatic KO.
3. **How the player gets up.** The input isn't visible in the footage. The player rose at 4 in 7 of 9 cases.
4. **Why some opponents stay down on their first knockdown.** It looks like a random roll weighted by tier, but a hidden rule (such as how fast the damage came, or excess damage) can't be ruled out.
5. **The exact time scale of hit-stop and dodge slow motion.** Only clock stalls were measured; the video is too compressed to measure frame freezes (Appendix B).
6. **Damage by punch type** (straight, hook or uppercut; head vs body) **and by punch speed.** The footage can't separate these.
7. **Trades.** Only one was seen (41:45.3), and only the opponent went down. The rule for which knockdown wins is unknown.
8. **Opponent rating changes.** Both rematches came back at a higher rating (+8 and +125). B05 (r410) and B27 (r1572) also share a name label. Unknown: whether opponent ratings move after every bout, and what decides a rematch.
9. **The 4 pips on the VS card.** Probably a player-slot indicator.
10. **What unlocks the cosmetic.** The glove color changed between ratings 1604 and 1656.
11. **Audio.** Only inferred from the visuals and waveform peaks. No voice lines or music were analyzed, and none should be copied.
12. **Things absent from the footage:** a stamina meter, clinches, referee breaks, fouls, footwork control (the distance stays fixed), special or charge punches, TKOs, judges' cards between rounds, and corner or rest scenes.
13. **When a pie stays on screen permanently.** It is always visible at about 3 wedges or fewer (M S7; V at 1.8 and 0.9), but the exact cut-off is unknown.

## Appendix A — Bout log

How to read this table:
- **P** marks an opponent with a PRO badge.
- **Opponent knockdowns** lists the count each knockdown rose at, in order. **X** means stayed down (KO).
- **Ended** gives the round and the time left on the clock.

| Bout | VS card at | Opponent rating | Player rating (Δ) | KO call at | Ended | Opponent knockdowns | Player knockdowns (rose at) | Notes |
|---|---|---|---|---|---|---|---|---|
| B01 | 0:00 | 118 | 0 → 75 (+75) | 1:58.0 | R1, ~2:21 | 7, X | – | Tutorial bout; 0.13 attacks/s |
| B02 | 2:37 | 139 | 75 → 149 (+74) | 3:12 | R1, 2:23 | X | – | First punch 0.33 s after the clock started |
| B03 | ~3:52 | 271 | 149 → 225 (+76) | 4:58.4 | R1, 1:45 | 8, X | – | Best guard of the early bouts |
| B04 | ~5:37 | 367 | 225 → 299 (+74) | 6:40.5 | R1, 1:49 | 7, X | – | 4-punch string |
| B05 | 7:20.5 | 410 | 299 → 372 (+73) | 7:50.5 | R1, 2:36 | X | – | Open guard; landed 0 hits |
| B06 | 8:16.5 | 520 | 372 → 445 (+73) | ~9:59 | R1, 0:36 | 6, 6, X | – | Fast one-twos to head and body |
| B07 | 10:27 | 503 | 445 → 518 (+73) | 10:59.3 | R1, ~2:35 | X | – | Passive, but guards |
| B08 | ~11:37 | 598 | 518 → 590 (+72) | 12:06.5 | R1, ~2:43 | X | – | No guard |
| B09 | ~12:31 | 692 | 590 → 623 (+33) | 15:56.4 | R2, 0:31 | 4, 9, 8, X | 4 | Slip-and-counter; blocked 67% |
| B10 | 16:29.5 | 757 | 623 → 694 (+71) | ~18:11 | R1, ~0:28 | 7, 6, X | – | High guard; counters in 0.2–0.65 s |
| B11 | 18:41 | 780 | 694 → 746 (+52) | 21:04.1 | R1, 0:03 | 7, 6, 8, X | 4 | Bursts of 3–4 hits |
| B12 | 21:42 | 828 | 746 → 816 (+70) | 23:48.6 | R2, ~2:06 | 4, X | – | Defensive counter-puncher |
| B13 | 24:27 | 922 | 816 → 887 (+71) | 24:55.1 | R1, after 7.3 s live | X | – | Passive |
| B14 | 25:20 | 1017 P | 887 → 935 (+48) | 27:29 | R2, 2:37 | 6, X | 4 | High guard, punishes everything |
| B15 | 28:07 | 1025 P (rematch of B14) | 935 → 931 (−4) | 32:20.25 | R3, ~2:05 | 3, 6, 8, X | 4, 6 | The only bout to reach round 3 |
| B16 | 32:59 | 981 | 931 → 978 (+47) | 36:33.8 | R2, 0:10 | 4, 5, 8, X | 4 | Holds cocked punches |
| B17 | 36:59 | 1122 P | 978 → 1047 (+69) | 39:33 | R2, 2:10 | 5, 9, X | – | The player reaches PRO |
| B18 | ~40:00 | 1177 P | 1047 → 1100 (+53) | ~43:29 | R2, ~0:40 | 6, 9, 7, X | 4 | Body hooks for 2–3 wedges; trade at 41:45.3 |
| B19 | 44:06 | 1168 P | 1100 → 1170 (+70) | 46:51.5 | R2, 2:07 | 6, 6, 8, X | – | Patient body counters |
| B20 | 47:17 | 1260 P | 1170 → 1238 (+68) | 49:15.4 | R2, 2:46 | 4, X | – | Block then counter; red-trail swings |
| B21 | 49:40.5 | 1303 P | 1238 → 1302 (+64) | ~52:27 | R2, ~1:14 | 6, 6, X | – | Rusher; drained the player to about 1/10 |
| B22 | 53:06 | 1425 P | 1302 → 1370 (+68) | 55:43.5 | R2, 2:43 | 7, 6, 9, X | – | Survived 3 knockdowns in round 1 |
| B23 | 56:08.5 | 1492 P | 1370 → 1437 (+67) | 58:28.5 | R2, 2:26 | 4, 6, X | – | Long straights; punches into the player's punches |
| B24 | 59:05.5 | 1487 P | 1437 → 1475 (+38) | ~62:53 | R2, ~0:10 | 4, 6, 8, X | 4 | Landed the most hits on the player |
| B25 | 63:18 | 1612 P (rematch of B24) | 1475 → 1541 (+66) | 66:30.0 | R2, ~1:03 | 6, 8, 8, X | – | Defensive in round 1, then a burst in round 2 |
| B26 | 67:08 | 1601 P | 1541 → 1604 (+63) | 69:32.7 | R2, 2:24 | 6, 6, X | – | Most pressure (about 12 hits per minute) |
| – | cut | ? | 1604 → 1656 (+52) | – | – | – | – | Removed by the uploader; the glove color changed here |
| B27 | 70:12 | 1572 P | 1656 → 1666 (+10) | 71:54 | R2, ~1:04 | 4 knockdowns, X on the 4th (counts trimmed) | 6, then ? (trimmed) | The only opponent rated below the player |

## Appendix B — How the merge checks were done

All checks ran on the source video (854×480, 30 fps) using OpenCV. The scripts and the frame grabs they produced were kept outside the repository.

1. **Wedge count (C1).** Fit the pie's center, sample grey levels around circles at 0.4–0.75 of the radius, and count the dark runs. The full pies at 16:53.0, 18:50.4 and 59:28.1 each gave 10 runs, 36° apart.
2. **Pie fill (C2–C5, C19).**
   - In each frame, find the blue pie with a color mask plus a circle detector (radius 34–42 px).
   - Measure how much of it is blue around circles at 0.45, 0.6 and 0.75 of the radius.
   - Over each 6-frame window, report the minimum (the true value) and the maximum (the value with the blinking wedge lit).
   - Scale so a full pie reads 10. Accuracy is about ±0.3 wedge.
3. **Refill (C11).** Zoomed crops of the opponent's pie, located with the circle detector, taken 0.3–2 s after each rise and counted by eye.
4. **Frame strips.** 30 fps at 28:25.4–28:26.3 (C5); 5 fps at 70:52.2–70:57.0 (C13); single frames during counts at 19:06.0, 24:47.0, 42:20.0 and 70:54.8 (C12).
5. **Tried, but inconclusive.** Detecting a frame freeze around the clean hit at 10:38.70 by frame differencing. Compression and camera sway hide any freeze, so the hit-stop figures rest on clock-stall data only.

## Appendix C — Evidence frames

The frame grabs behind the findings above (kept with the scripts, Appendix B), for internal reference only: never ship them or trace from them.

- Pies have 10 wedges.
- The blinking wedge at the health edge.
- Refill of 8/6/4 after get-ups.
- A landed hit that looked like a block (C5).
- Knockdown count views, no referee.
- The trimmed player get-up (C13).
- A block ring, then the player hit by a one-two.
- Dodge, slow motion, counter.
- The opponent's block, counter and the player-hit camera.
- Power-hook tell.
- Block, counter, knockdown of the player.
- Round break.
- Post-KO flow.
- VS and results cards.
- Tutorial cards.
