# cross-dir fixture

Tests the LIMITATION of v1 heuristic: a single logical system that spans
3 different top-level dirs (apps/api/, packages/shared/, scripts/).

The v1 heuristic will likely find **zero** or fragment this into pieces.
The v2 hypothesis pass should reunify it.
