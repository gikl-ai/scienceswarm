# Project Alpha Research Notes

Some observations about the transformer experiment we ran last week.

## Findings

- Attention heads converge faster with layer normalization
- Larger batch sizes produced better results in our setup
- Need to follow up on the gradient instability around step 10k

## Open questions

- How does this compare to BERT pretraining?
- What is the best sequence length for our protein folding task?
