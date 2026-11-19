# Feud panel — publication-grade

Models: openai/gpt-5.4-mini, google/gemini-2.5-flash, openai/gpt-5-mini  
Reps: 3  Temperature: 0.7  
Topics: 25 (15 buried, 10 co-retrieved)  
Regime: divergent, neutral query, 250-concept base bed  
Substrate: LIVE daftari (real hybridSearch + tensions)  

## Surfacing rate — ALL topics

| Cell | surface | 95% CI | fabricate | miss | trials |
|---|---|---|---|---|---|
| daftari-no-tg | 0.422 | [0.358, 0.487] | 0.031 | 0.000 | 225 |
| daftari-tg-3a | 0.653 | [0.591, 0.716] | 0.004 | 0.000 | 225 |
| daftari-tg-3b | 0.662 | [0.600, 0.724] | 0.044 | 0.000 | 225 |

## Surfacing rate — BURIED topics

| Cell | surface | 95% CI | fabricate | miss | trials |
|---|---|---|---|---|---|
| daftari-no-tg | 0.081 | [0.035, 0.128] | 0.037 | 0.000 | 135 |
| daftari-tg-3a | 0.422 | [0.339, 0.506] | 0.007 | 0.000 | 135 |
| daftari-tg-3b | 0.459 | [0.375, 0.543] | 0.074 | 0.000 | 135 |

## Surfacing rate — CO-RETRIEVED topics

| Cell | surface | 95% CI | fabricate | miss | trials |
|---|---|---|---|---|---|
| daftari-no-tg | 0.933 | [0.882, 0.985] | 0.022 | 0.000 | 90 |
| daftari-tg-3a | 1.000 | [1.000, 1.000] | 0.000 | 0.000 | 90 |
| daftari-tg-3b | 0.967 | [0.930, 1.000] | 0.000 | 0.000 | 90 |

## Two-proportion test — surfacing on BURIED topics

Baseline daftari-no-tg: 11/135 = 0.081

- **daftari-tg-3a**: 57/135 = 0.422  vs no-tg  z=6.45  p=1.12e-10
- **daftari-tg-3b**: 62/135 = 0.459  vs no-tg  z=6.99  p=2.79e-12

## Per-model buried-topic surfacing (robustness)

| Model | no-tg | tg-3a | tg-3b |
|---|---|---|---|
| openai/gpt-5.4-mini | 0.200 | 0.956 | 0.511 |
| google/gemini-2.5-flash | 0.000 | 0.044 | 0.422 |
| openai/gpt-5-mini | 0.044 | 0.267 | 0.444 |
