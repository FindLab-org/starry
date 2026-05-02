# From Image to Music Language: A Two-Stage Structure Decoding Approach for Complex Polyphonic OMR

[![Deploy GitHub Pages](https://github.com/FindLab-org/starry/actions/workflows/pages.yml/badge.svg)](https://github.com/FindLab-org/starry/actions/workflows/pages.yml)

- Blog: https://findlab-org.github.io/starry/
- Paper: [arXiv:2604.20522](https://arxiv.org/abs/2604.20522)
- Live Demo: [&#x1f917;Starry space](https://huggingface.co/spaces/k-l-lambda/starry)

The core code related to the Starry✨ project will be organized and released in this repository.

## Abstract

We propose a new approach for a practical two-stage Optical Music Recognition (OMR) pipeline, with a particular focus on its second stage. Given symbol and event candidates from the visual pipeline, we decode them into an editable, verifiable, and exportable score structure. We focus on complex polyphonic staff notation, especially piano scores, where voice separation and intra-measure timing are the main bottlenecks. Our approach formulates second-stage decoding as a structure decoding problem and uses topology recognition with probability-guided search (BeadSolver) as its core method. We also describe a data strategy that combines procedural generation with recognition-feedback annotations. The result is a practical decoding component for real OMR systems and a path to accumulate structured score data for future end-to-end, multimodal, and RL-style methods.


## Relative Repositories

* [**Lotus**](https://github.com/k-l-lambda/lotus) — an SVG/LilyPond geometry pipeline used by the paper to recover per-glyph positions from engraved scores, giving generated topology samples realistic spatial layouts.
* [**Paraff**](https://github.com/FindLab-org/paraff) — a compact symbolic-music DSL used in the paper's data-generation strategy to sample structurally valid measure-level music for topology-recognition training; this project is now archived, with *Lilylet* as its successor.
* [**IMSLP-Mining**](https://github.com/k-l-lambda/imslp-mining) — a related data-mining project for converting open sheet-music images into usable symbolic datasets.
* [**Lilylet**](https://github.com/k-l-lambda/lilylet) — a symbolic-music language designed as a LilyPond variant; Starry OMR supports Lilylet as one of its export formats for structured recognition results.
