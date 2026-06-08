# AI Team Phase 2 Kanban Top-Down Map

> Review target: aiteam full-product Kanban workflow
>
> Layout: top-down DAG, with fan-out / fan-in shown explicitly

## Legend

- `[]` = task card
- `-->` = dependency / handoff
- `|` / `+` = fan-out or fan-in point
- implementation cards use **per-card worktrees**
- reviewer / QA / closeout stay on the shared integration workspace

---

## 1) Global workflow shape

```text
[P2-ROOT t_eeeff532
 AI Team PRD full product expansion start gate]
        |
        v
[P2-SETUP t_94a862ef
 graph review before execution]
        |
        v
[P2-S00 t_bcce763b
 PRD coverage matrix and scope freeze]
        |
        +--> [P2-S00B t_85669bb6
             B03 / Loop / payment / provider scope decisions]
        |
        v
[P2-S00 ARCH t_93c58a3d
 contract and architecture freeze]
        |
        +-----------------------------+-----------------------------+-----------------------------+-----------------------------+
        |                             |                             |                             |
        v                             v                             v                             v
  [P2-BATCH1]                   [P2-BATCH2]                   [P2-BATCH3]                   [P2-BATCH4]
  foundations                   capabilities                  experience                      commercial / admin / auth
        |                             |                             |                             |
        v                             v                             v                             v
    review                        review                        review                        review
        |                             |                             |                             |
        v                             v                             v                             v
       QA                           QA                           QA                           QA
        |                             |                             |                             |
        v                             v                             v                             v
   closeout                     closeout                     closeout                     closeout
        \______________________________|______________________________|______________________________/
                                       v
                                [P2-FINAL REVIEW]
                                       |
                                       v
                               [P2-S15 QA gate]
                                       |
                                       v
                             [P2-PM-SIGNOFF accepted?]
                                       |
                                       v
                          [P2-PROGRAM-CLOSEOUT t_63e2adc5]
```

---

## 2) Batch fan-out / fan-in details

### P2-BATCH1 — foundations

```text
[P2-S00 ARCH t_93c58a3d]
        |
        +--> t_576666f3  backend-eng   org/member/department/role foundation
        +--> t_ff99b3b4  frontend-eng   org tree and member/settings pages
        +--> t_37cc308b  data-rd        knowledge ingestion and LightRAG data path
        +--> t_632f0164  backend-eng   knowledge API binding citation service
        +--> t_7366424f  backend-eng   employee configuration center
        +--> t_07616f70  frontend-eng   employee configuration drawer
        +--> t_04500fac  architect      auth/session/enterprise entrance contract freeze
                        |
                        v
                 t_83510727 REVIEW
                        |
                        v
                 t_2d349ba1 QA
                        |
                        v
                 t_b3c04d1b CLOSEOUT
```

### P2-BATCH2 — skills / connectors / memory

```text
[t_b3c04d1b]
        |
        +--> t_d1c4846a  backend-eng   skill market install/update/permission
        +--> t_59676cb8  backend-eng   gateway skill provisioning into employee profiles
        +--> t_e9a3f828  frontend-eng   skill market and employee skill tabs
        +--> t_ae94ee82  backend-eng   connector center credential/state/logs
        +--> t_76c560af  backend-eng   connector credential resolver adapter seam
        +--> t_305d91d7  frontend-eng   connector center
        +--> t_1ac3eda4  data-rd        memory model and extraction jobs
        +--> t_3a286c54  backend-eng   memory management prompt injection record
        +--> t_64fcce53  backend-eng   Hermes memory integration
        +--> t_169fbf93  frontend-eng   memory management pages
                        |
                        v
                 t_7132fd3b REVIEW
                        |
                        v
                 t_f0f7b66e QA
                        |
                        v
                 t_fcc0f3aa CLOSEOUT
```

### P2-BATCH3 — chat / workbench / loop / office / solution

```text
[t_fcc0f3aa]
        |
        +--> t_1fd62c3e  backend-eng   chat/group/orchestration semantics
        +--> t_d4bb3ef3  backend-eng   gateway retry/cancel/reconnect semantics
        +--> t_f914c6cb  frontend-eng   chat/group/task-tree experience
        +--> t_8ad8911e  backend-eng   office dynamic status view
        +--> t_15889d68  frontend-eng   office dynamic scene
        +--> t_9426336c  backend-eng   workbench aggregation and navigation state
        +--> t_e5340734  frontend-eng   workbench navigation information architecture
        +--> t_7e7859ec  backend-eng   Loop ScheduledJob product monitoring semantics
        +--> t_4a74e8ea  frontend-eng   Loop ScheduledJob monitoring UI
        +--> t_279fc317  backend-eng   industry solution full apply/statistics
        +--> t_23a04c65  backend-eng   system-admin industry solution management
        +--> t_5c0e4983  frontend-eng   industry solution marketplace/admin
                        |
                        v
                 t_41f973c0 REVIEW
                        |
                        v
                 t_9b18e7c1 QA
                        |
                        v
                 t_7b1a828d CLOSEOUT
```

### P2-BATCH4 — commercial / admin / auth

```text
[t_7b1a828d]
        |
        +--> t_d21df8e3  backend-eng   billing recharge balance deduction
        +--> t_a2775bab  frontend-eng   enterprise billing and recharge
        +--> t_2d2cec95  backend-eng   system finance aggregation
        +--> t_c9ef67dc  backend-eng   system-admin enterprise account management
        +--> t_1bca9a64  backend-eng   system-admin expert template management
        +--> t_0934489a  frontend-eng   system accounts/templates pages
        +--> t_19a2c484  backend-eng   enterprise settings notifications help feedback
        +--> t_c38a4b11  frontend-eng   enterprise settings page
        +--> t_63325ab3  backend-eng   permission audit export observability hardening
        +--> t_d3e6637b  backend-eng   login account session security
        +--> t_182e0028  frontend-eng   login and onboarding
        +--> t_653289f6  backend-eng   talent market expert detail productization
        +--> t_35fede14  frontend-eng   talent market expert detail productization
                        |
                        v
                 t_f8aa1f87 REVIEW
                        |
                        v
                 t_becf3c04 QA
                        |
                        v
                 t_608fdd65 CLOSEOUT
```

---

## 3) Final acceptance chain

```text
[t_608fdd65 P2-BATCH4 CLOSEOUT]
        |
        v
[t_f905c2cd P2-FINAL REVIEW]
        |
        v
[t_3978235f P2-S15 QA PRD full regression]
        |
        v
[t_bb8f934a P2-PM-SIGNOFF]
        |
        v
[t_63e2adc5 P2-PROGRAM-CLOSEOUT]
```

---

## 4) Notes for review

- This graph is intentionally **top-down**: root and scope freeze first, then batch fan-out, then gate fan-in.
- Implementation cards are the only cards using **per-card worktrees**.
- Review / QA / closeout remain on the shared integration workspace so evidence stays comparable.
- The graph is designed to avoid the earlier serial bottleneck: parallel implementation happens inside each batch, while acceptance remains sequential.
- The current manifest path is:
  - `/home/ubuntu/.hermes/profiles/orchestrator/runtime/workflows/aiteam-phase2-full-prd-kanban-manifest.json`

---

## 5) Quick reference: current root + closeout IDs

- Root: `t_eeeff532`
- Graph review: `t_94a862ef`
- PM sign-off: `t_bb8f934a`
- Program closeout: `t_63e2adc5`

