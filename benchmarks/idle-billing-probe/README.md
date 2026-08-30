# Idle-billing probe

Settles the one unverified claim in the cost story: does an idle-but-
connected `flux-2/klein/realtime` WebSocket bill anything? The pricing page
implies no (billing is per compute second of generation), but it is not
documented.

```bash
./run.sh              # 10-minute idle hold, then a usage check
./run.sh --minutes 3  # shorter hold
```

Uses `FAL_KEY` from the environment or `../../.env.local`; mints a
short-lived token exactly like the app server, connects, sends **nothing**,
then queries the usage API (falls back to pointing you at the dashboard if
your key isn't admin-scoped). Expected cost: $0. Run it yourself — it
touches your fal account.
