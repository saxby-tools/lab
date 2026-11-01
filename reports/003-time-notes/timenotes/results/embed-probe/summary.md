# Embedding probe: a time note in the stored text

Recall at k over 120 rows, 240 paraphrased queries, percent, mean of three seeds of drawn times; embedder bge-m3.

| Condition | What | At 1 | At 5 | At 10 | Margin | Row cosine |
| --- | --- | --- | --- | --- | --- | --- |
| plain | Fact text as is | 81.2 | 98.8 | 100.0 | 0.059 | 0.411 |
| word | Daypart word note in front | 84.9 | 100.0 | 100.0 | 0.058 | 0.480 |
| clock | Clock time note in front | 86.4 | 99.7 | 100.0 | 0.059 | 0.488 |
| iso | ISO 8601 note in front | 85.7 | 99.4 | 100.0 | 0.062 | 0.435 |

Margin is the mean cosine gap between the right row and the best wrong row; row cosine is the mean cosine between any two stored rows, higher meaning a shared prefix pulls them together.
