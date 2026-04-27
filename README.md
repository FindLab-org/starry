# From Image to Music Language: A Two-Stage Structure Decoding Approach for Complex Polyphonic OMR

- Blog: https://findlab.github.io/starry
- Paper: [arXiv:2604.20522](https://arxiv.org/abs/2604.20522)
- Live Demo: [&#x1f917;Starry space](https://huggingface.co/spaces/k-l-lambda/starry)

## Abstract

We propose a new approach for a practical two-stage Optical Music Recognition (OMR) pipeline, with a particular focus on its second stage. Given symbol and event candidates from the visual pipeline, we decode them into an editable, verifiable, and exportable score structure. We focus on complex polyphonic staff notation, especially piano scores, where voice separation and intra-measure timing are the main bottlenecks. Our approach formulates second-stage decoding as a structure decoding problem and uses topology recognition with probability-guided search (BeadSolver) as its core method. We also describe a data strategy that combines procedural generation with recognition-feedback annotations. The result is a practical decoding component for real OMR systems and a path to accumulate structured score data for future end-to-end, multimodal, and RL-style methods.
