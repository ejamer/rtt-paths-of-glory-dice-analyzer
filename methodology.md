# Methodology

Every die roll in the game log gets attached to the event it was part of —
combat, entrench, siege, or mandated offensive — instead of being treated as
a bare number. The goal is to assess whether a roll was actually *helpful*
to the player, not just where it falls on 1–6: a raw roll is compared
against what the game rules did with it (Combat Factor, target number,
modifier), and where possible against what the rules alone would have
predicted regardless of the roll.

The parsed data is also available as a downloadable JSON file, shaped like:

```
{
    "game_metadata": { "game_id": <rtt_game_id>, "ap_player": <name>, "cp_player": <name> },
    "all_ap_rolls": [ <raw dice results from the AP player> ],
    "all_cp_rolls": [ <raw dice results from the CP player> ],
    "combat_results": [
        {
            "location": <combat_space_name>,
            "attacker": <AP|CP>,
            "flank_attempt": { "modifier": <number>, "actual_roll": <number>, "result": <success|fail> } | null,
            "attacker_details": {
                "combat_cards": [ <card names> ],
                "combat_factor": <number>,
                "column_modifier": <string>,
                "actual_roll": <number>,
                "die_modifier": <number>,
                "expected_losses_inflicted": <number>,
                "actual_losses_inflicted": <number>
            },
            "defender_details": { "...": "same shape as attacker_details" },
            "expected_combat_winner": <AP|CP|Tie>,
            "actual_combat_winner": <AP|CP|Tie>,
            "loss_ratio": "<attacker_losses>:<defender_losses>",
            "retreat": { "forced": <bool>, "canceled": <bool> }
        }
    ],
    "entrench_rolls": {
        "ap_rolls": [ <ap entrench rolls> ], "cp_rolls": [ <cp entrench rolls> ],
        "entrench_attempt_<#>": { "attempting_faction": <AP|CP>, "location": <space>, "modifier": <number>, "target": <number>, "actual_roll": <number>, "result": <success|fail> }
    },
    "siege_rolls": {
        "siege_attempt_<#>": { "attempting_faction": <AP|CP>, "location": <space>, "target": <number>, "modifier": <number>, "actual_roll": <number>, "result": <success|fail> }
    },
    "mandated_offense_rolls": {
        "ap_rolls": [ <ap rolls> ], "cp_rolls": [ <cp rolls> ],
        "turn_<#>": { "ap_roll": <number>, "ap_result": <string>, "cp_roll": <number>, "cp_result": <string> }
    }
}
```

# Combat

Both players roll dice, look up results from the Combat Tables (based on the
strength of their attacking/defending forces), and apply losses. The side
that inflicts the higher loss value wins the combat. Higher rolls are always
better, but the difference in strength between the two forces can mean a
favorable roll still doesn't translate into inflicting more damage.

The report first looks at overall average die roll for each side over the
course of the game, plotted over time — the "higher is better" view. It also
shows how frequently each roll difference in a specific combat occurs, on a
chart that goes from +5 AP to 0 to +5 CP; for example, CP rolls 5 and AP
rolls 1, so the difference is +4 CP.

Beyond that, the report gets more granular: how often each side won, tied,
or lost combat, compared against the expected result for the given force
strengths in that combat (a small force attacking a much larger one is
expected to lose, even if the dice favor the small force). A key metric is
how often that expectation was overturned, for either the attacker or
defender. Win/tie/loss over time is also plotted per side.

The report also shows how many retreats were forced on each side by lost
combats, split by retreat length (1 space vs. 2), and how many were
canceled (taking extra losses to hold the space instead). The log doesn't
state a retreat's length directly, so it's derived from the rules formula —
the loss margin between attacker and defender, capped at 2 spaces — rather
than the unit-movement text, which doesn't reliably indicate distance
moved.

Flank attempts let the attacker inflict losses before the defender can
return fire, so get their own subsection under Combat: how many flank rolls
were attempted, broken out by side and by modifier level, and their success
rates.

## Combat Results Notes

- only the Attacker is recorded explicitly; the Defender is always the
  non-Attacker side
- flank attempts succeed on a (modified) result of 4 or higher; some combat
  cards cause flank success regardless of roll
- combat factor involves a strength number, and either Corps or Army status;
  ex: 12 (Army), 4 (Corps)
- expected losses checks the appropriate combat table column (see below),
  sums the results for die roll of 3 and 4, then divides by 2
- combat winner is determined by who inflicts the most losses; can be a tie
  (i.e. no winner)

## Combat Tables

Corps Fire Table
| Die Roll | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8+ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 1 | 1 | 1 | 1 | 1 | 2 |
| 2 | 0 | 0 | 1 | 1 | 1 | 1 | 1 | 2 | 2 |
| 3 | 0 | 0 | 1 | 1 | 1 | 2 | 2 | 2 | 3 |
| 4 | 0 | 1 | 1 | 1 | 2 | 2 | 2 | 3 | 3 |
| 5 | 1 | 1 | 1 | 2 | 2 | 2 | 3 | 3 | 4 |
| 6 | 1 | 1 | 1 | 2 | 2 | 3 | 3 | 4 | 4 |

Army Fire Table
| Die Roll | 1 | 2 | 3 | 4 | 5 | 6-8 | 9-11 | 12-14 | 15 | 16+ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 1 | 1 | 2 | 2 | 3 | 3 | 4 | 4 | 5 |
| 2 | 1 | 1 | 2 | 2 | 3 | 3 | 4 | 4 | 5 | 5 |
| 3 | 1 | 2 | 2 | 3 | 3 | 4 | 4 | 5 | 5 | 7 |
| 4 | 1 | 2 | 3 | 3 | 4 | 4 | 5 | 5 | 7 | 7 |
| 5 | 2 | 3 | 3 | 4 | 4 | 5 | 5 | 7 | 7 | 7 |
| 6 | 2 | 3 | 4 | 4 | 5 | 5 | 7 | 7 | 7 | 7 |

# Entrench

Entrenching requires a target roll less than or equal to the loss factor of
the attempting Army unit (see below for loss factors). Sometimes there's a
-1 modifier on the roll to improve the odds.

The report shows success/fail percentages for entrench rolls per side
overall, then breaks that down by Army nationality, and again by the actual
target value being tested (loss factor adjusted for any modifier).

## Army Loss Factors

AP Armies:
- FR 3
- BR 3
- IT 2
- RU 2
- BE 3
- USA 3
- SB 2

CP Armies:
- GE 3
- AH 2
- TU 2

# Siege

Siege occurs when a fort space is occupied at the end of a Turn. A single
roll is made, and if the modified value is higher than the combat factor
(CF) of that space, the fort is destroyed.

The report shows average rolls during sieges for each side, and success
percentage broken out by target value (with modifiers applied).

# Mandated Offense

Rolled once at the start of each turn. May require players to alter their
plans or surrender points in the game. Higher values are better for the CP
player; low values are typically better for the AP player, although this
can be situational.

The report displays a chart of die values from each turn of the game (both
players on the same chart), followed by frequency breakdowns of table
results for both the AP and CP players.

## Mandated Offense Tables

CP
| Die Roll | Result |
| 1 | AH |
| 2 | AH (IT) |
| 3 | TU |
| 4 | GE |
| 5 | None |
| 6 | None |

AP
| Die Roll | Result |
| 1 | FR |
| 2 | FR |
| 3 | BR |
| 4 | IT |
| 5 | IT |
| 6 | RU |
