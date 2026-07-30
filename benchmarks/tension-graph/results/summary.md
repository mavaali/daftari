# Feud panel — publication-grade (Phase 1: stand-in substrate)

Models: openai/gpt-5.4-mini, google/gemini-2.5-flash, openai/gpt-5-mini  
Reps: 3  Temperature: 0.7  
Topics: 25 (15 buried, 10 co-retrieved)  
Regime: divergent, neutral query, 250-concept base bed  
Substrate: information-faithful stand-in (NOT live daftari MCP)  

## Surfacing rate — ALL topics

| Cell | surface | 95% CI | fabricate | miss | trials |
|---|---|---|---|---|---|
| data-olympus | 0.316 | [0.255, 0.376] | 0.040 | 0.413 | 225 |
| daftari-no-tg | 0.289 | [0.230, 0.348] | 0.044 | 0.436 | 225 |
| daftari-tg-3a | 0.440 | [0.375, 0.505] | 0.058 | 0.298 | 225 |
| daftari-tg-3b | 0.609 | [0.545, 0.673] | 0.053 | 0.213 | 225 |

## Surfacing rate — BURIED topics

| Cell | surface | 95% CI | fabricate | miss | trials |
|---|---|---|---|---|---|
| data-olympus | 0.007 | [0.000, 0.022] | 0.067 | 0.541 | 135 |
| daftari-no-tg | 0.022 | [0.000, 0.047] | 0.074 | 0.526 | 135 |
| daftari-tg-3a | 0.185 | [0.120, 0.251] | 0.081 | 0.407 | 135 |
| daftari-tg-3b | 0.444 | [0.361, 0.528] | 0.074 | 0.289 | 135 |

## Surfacing rate — CO-RETRIEVED topics

| Cell | surface | 95% CI | fabricate | miss | trials |
|---|---|---|---|---|---|
| data-olympus | 0.778 | [0.692, 0.864] | 0.000 | 0.222 | 90 |
| daftari-no-tg | 0.689 | [0.593, 0.785] | 0.000 | 0.300 | 90 |
| daftari-tg-3a | 0.822 | [0.743, 0.901] | 0.022 | 0.133 | 90 |
| daftari-tg-3b | 0.856 | [0.783, 0.928] | 0.022 | 0.100 | 90 |

## Two-proportion test — surfacing on BURIED topics

Baseline daftari-no-tg: 3/135 = 0.022

- **daftari-tg-3a**: 25/135 = 0.185  vs no-tg  z=4.39  p=1.13e-05
- **daftari-tg-3b**: 60/135 = 0.444  vs no-tg  z=8.20  p=2.22e-16

## Per-model buried-topic surfacing (robustness)

| Model | no-tg | tg-3a | tg-3b |
|---|---|---|---|
| openai/gpt-5.4-mini | 0.000 | 0.378 | 0.511 |
| google/gemini-2.5-flash | 0.000 | 0.044 | 0.356 |
| openai/gpt-5-mini | 0.067 | 0.133 | 0.467 |
