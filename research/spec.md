# Boxing Game Functional Specification

Version 1.1

## 1 Purpose and scope

This document specifies the functionality of a boxing game controlled through handheld motion controllers. It covers starting a session, controlling a boxer, resolving a match, practicing skills and retaining player progress. Product, design, engineering and QA readers can use the requirement IDs and acceptance checks to review the experience.

The player controls a boxer avatar using one motion controller in each hand. The central interaction is to attack, defend and create opportunities to land punches. A player profile holds the avatar, preferences and activity records.

## 2 Supported experiences

| Experience | Participants and equipment | Player objective |
| --- | --- | --- |
| Single player | One human against a computer opponent; one pair of motion controllers. | Defeat the opponent and develop boxing skill. |
| Local versus | Two human boxers; a separate controller pair for each. | Win the shared match. |
| Boxing training | One to four participants take turns; a controller pair can be shared. | Improve performance in a focused practice activity. |
| Fitness assessment | One player completes a selection of training activities. | Receive an estimated fitness age. |

## 3 Player journey

Choose an experience and player profile, confirm the controls, enter the activity, receive continuous feedback, then review the result. A match routes to skill feedback where applicable; a practice activity routes to its score and award.

**Reading the specification.** Baseline requirements define the intended gameplay. Items explicitly labeled proposed identify additional implementation expectations for review. The state model and acceptance checks make those requirements testable. Section 9 identifies parameters and decisions that still require validation.

## 4 Setup and controls

**SET01 Player identity.** Allow selection of a local player profile, a guest profile or a portable profile imported from another device. Display the avatar associated with the selected profile as the player's boxer.

**SET02 Play style.** Offer handedness selection before play. Make each controller's glove assignment clear to the player.

**SET03 Controller assignment.** Associate each active boxer with two motion controllers, one for each hand. In local versus, keep each pair assigned to its own player.

### Motion inputs

| ID | Player input | Observable game response |
| --- | --- | --- |
| COM01 | Thrust either controller forward. | The associated glove throws a punch. |
| COM02 | Punch with an upward or downward aim. | The attack targets the head or body respectively. |
| COM03 | Hold both controllers in a guarding posture. | The boxer raises the gloves to block. |
| COM04 | Lean forward, backward or sideways while maintaining the fighting posture. | The boxer shifts position to evade incoming attacks. |

Body movement affects the boxer through the movement of the held controllers. Motion sensing supplies the input for posture and evasion.

### Combat behavior

**COM05 Attack resolution.** Resolve an attack against the opponent's current position and defense. A swing can connect, be guarded or miss. Timing and distance influence whether an opening is usable.

**COM06 Counterattack opportunities.** Allow the player to follow an evasion with a punch. Any special counterattack timing window or damage modifier remains an implementation parameter.

**COM07 Input separation.** Proposed implementation requirement: menu gestures, idle controller movement and the return movement after a punch should not create unintended additional attacks. Validate recognition using captured input examples before choosing sensitivity thresholds.

### Menu inputs

| Action | Response |
| --- | --- |
| Confirm | Accept the highlighted selection. |
| Back | Return to the previous screen. |
| Pause | Open the in-game pause menu. |
| System menu | Open the host platform's system menu, where available. |

Map these actions to the controls available on the target platform.

## 5 Match rules and state changes

**MAT01 Round structure.** Play up to three one-minute rounds. A knockout can end the bout earlier; otherwise a judges' decision determines the result after the final round.

**MAT02 Damage and knockdowns.** Landed punches accumulate damage. Sufficient damage causes a knockdown and interrupts the exchange. A knockdown and a match-ending knockout are separate events.

**MAT03 Count and continuation.** During a knockdown, the referee counts. A boxer who fails to rise by ten loses; a recovery permits the bout to continue.

The following state model defines event boundaries without prescribing damage, recovery or judging calculations.

| State | Trigger | Next state or visible result |
| --- | --- | --- |
| Setup | Required selections are complete. | Introduce the participants and prepare the first round. |
| Active round | A valid attack or defense input occurs. | Resolve the exchange and update feedback. |
| Knockdown | Damage causes a boxer to fall. | Suspend ordinary fighting and show the count sequence. |
| Recovery | The downed boxer rises. | Restore a playable fighting state. |
| Round boundary | A nonfinal round ends without a knockout. | Advance to the next round. |
| Match end | A knockout or final decision occurs. | Present the outcome and end combat processing. |
| Paused | The player opens the pause menu. | Route to continue, restart or quit. |

### Outcome presentation

**MAT04 Result clarity.** Proposed implementation requirement: present the adjudicated outcome, identify the winner where applicable and show whether the bout ended by knockout or decision. Resolve the outcome once, then prevent subsequent gestures from altering that result.

Clock behavior during interruptions, recovery logic, judging weights and simultaneous-event precedence require validation; see Section 9.

## 6 Training and progression

### Boxing training

**TRN01 Practice selection.** Provide Bag practice, Dodging drill and Target punching as distinct activities. Each isolates a different part of boxing.

| Activity | Required interaction | Score behavior |
| --- | --- | --- |
| Bag practice | Strike hanging bags until they fall from their chains. Present subsequent bags during the timed activity. | Reward completed bags. |
| Dodging drill | Move the boxer to avoid the trainer's incoming tennis balls. | Reward successful avoidance. Exact counting and penalties require validation. |
| Target punching | Strike the mitts presented by the trainer, including occasions when both are raised. | Reward mitt hits and deduct points for hitting the trainer. |

**TRN02 Practice results.** Present the activity score and any earned medal. Support bronze, silver, gold and platinum awards, repeat attempts and comparison of performance.

### Single player progression

**PRG01 Opponent challenge.** Computer-controlled opponents become tougher as the player progresses. Their attacks create opportunities to practice guarding, evasion and counterattacking.

**PRG02 Skill and Pro status.** Skill changes with performance. Local human-versus-human bouts leave it unchanged. Above 1,000 points earns Pro status, which can later be lost.

### Saved records

**SAV01 Profile records.** Automatically save play records for local player profiles. Do not save play records for guest profiles or portable profiles. Deleting a local player profile also erases its associated play records.

Associate saved progress with the player profile rather than the current controller number. Keep match skill, training results and fitness results as distinct concepts so an update in one mode does not overwrite another. These are proposed data requirements.

### Fitness assessment

Combine three selected training activities into an estimated fitness age based on balance, stamina and speed. Make the assessment available once per day per player profile. Store results in the profile's activity history when its records are eligible for saving. The calculation and the definition of a daily reset require validation.

## 7 Screens and session behavior

### Gameplay feedback

**UI01 Combat view.** Show the player's boxer and opponent with enough visibility to read glove movement and defensive posture. Use split screen for local human-versus-human boxing.

**UI02 Match indicators.** Present a round timer and health feedback alongside the fight. The combat display and knockdown count communicate the changing state of the bout.

**UI03 Consistent feedback.** Proposed implementation requirement: synchronize the visible hit reaction, condition indicator and outcome of each resolved attack. Give hits, guards and misses distinguishable feedback. Round and result transitions should be understandable from the screen without relying solely on sound.

### Pause and navigation

**SES01 Pause actions.** The pause menu offers Continue, Start over and Quit. Continue resumes; Start over begins again; Quit returns to the menu.

**SES02 Session integrity.** Proposed implementation requirement: continuing restores the same participants and activity state. Restarting clears transient match state before a new start. Quitting removes the active activity and returns control to the selected menu. Do not apply a completed-result update twice.

### Proposed interruption requirements

The following requirements define expected interruption and recovery behavior for implementation review.

**ERR01 Missing controller.** Before an activity starts, identify any required controller that is unavailable and keep the session in setup until the player can proceed.

**ERR02 Connection lost.** If an active controller disconnects, suspend the activity and explain which player must reconnect. Preserve the active state and require a deliberate resumption after the connection is restored.

**ERR03 Unrecognized gesture.** Ignore an input that does not match a supported action. It must not create damage or a score event simply because movement occurred.

**ERR04 Save unavailable.** Distinguish a completed activity from a successfully saved record. If persistence fails, explain the failure and preserve a path back to play without falsely reporting that progress was saved.

## 8 Acceptance checks

These are proposed verification scenarios, not executed test results. Test both controller assignments and compare the same player profile before and after persistence checks. Judge the visible response and the resulting game state together. Resolve proposed behavior as a product decision before treating it as a release requirement.

| Check | Requirements | Scenario and expected evidence |
| --- | --- | --- |
| A01 | SET01–SET03 | Enter each supported match setup. Verify the selected profile and avatar, opponent type and controller ownership. |
| A02 | COM01 | Perform a recognized punch gesture with each controller independently. Confirm that the associated glove acts without a duplicate attack from the other hand. |
| A03 | COM02 | Compare head-directed and body-directed gestures. Record a visible change in the attack target. |
| A04 | COM03–COM05 | Replay representative incoming attacks against guard, evasion and an exposed boxer. Confirm distinct outcomes. |
| A05 | COM06–COM07 | Dodge, return to guard and counterpunch. Check that the intended attack is recognized without an extra return-motion punch. |
| A06 | MAT02–MAT03 | Capture a recoverable knockdown and a terminal count. Confirm separate continuation and defeat paths. |
| A07 | MAT01, MAT04 | Complete a bout without an early knockout. Verify round advancement, final adjudication and one stable result. |
| A08 | UI01–UI03 | Run local versus and inspect both views. Confirm that each view identifies its player and reflects the same fight. |
| A09 | SES01–SES02 | Exercise continue, restart and quit from an activity. Check the destination and retained or cleared state. |
| A10 | TRN01–TRN02 | Run every practice activity. Confirm its target interaction, score events and result screen. |
| A11 | PRG02 | Compare eligible single player and local versus results. Verify that the correct progression policy applies. |
| A12 | SAV01 | Leave and reopen the game after a record-setting activity. Compare local, guest and portable profile behavior. |
| A13 | ERR01–ERR02 | Remove required controllers before setup and during play. Verify the proposed recovery flow and player assignment. |
| A14 | ERR03–ERR04 | Inject an unsupported input and a failed save. Confirm that neither produces a false success. |

## 9 Implementation parameters and unresolved decisions

Establish and validate the following details before implementation sign-off. Keep these decisions consistent with the baseline rules above.

| Area | Details to establish |
| --- | --- |
| Motion and combat | Gesture thresholds; hook and uppercut recognition; attack recovery time; damage amounts; guard coverage; counterattack timing. |
| Clock and knockdowns | Clock behavior during interruptions; whether time advances during the count; recovery input and health restoration; repeated knockdowns. |
| Judging and event order | Decision weights; draw conditions; simultaneous knockdowns; a decisive hit at a round boundary. |
| Progress and practice | Skill adjustment formula; computer-opponent selection; training duration and score arithmetic; medal cutoffs; unlock and cosmetic conditions. |
| Profiles and platform behavior | Portable-profile transfer; physical menu-button mappings; fitness-age calculation; daily reset time and time zone. |
