# Architecture Decision Records

One file per decision: `YYYY-MM-DD-short-title.md`. Never edit an accepted ADR; supersede it with a new one.

Format:

```
# YYYY-MM-DD — Title

Status: proposed | accepted | superseded by <file>
Phase: P# / O#

## Context
What forced the decision. Facts and evidence only; mark unverified items UNVERIFIED.

## Options
Each option with its cost and risk.

## Decision
The chosen option and why.

## Consequences
What changes, what it blocks, what to re-check later.
```

A design blocker found at a phase gate becomes an ADR and the phase stops.
