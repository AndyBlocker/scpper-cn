# S3 已删页脚本化签核（2026-07-28）

固定种子 `s3-deleted-signoff-2026-07-28`，按有效票数量级分层抽样 100 页；
强制覆盖 C3 `|A3 rating - last PageVersion rating|` 最大的 20 页。
v1 连接以 `REPEATABLE READ READ ONLY` 运行；归档仅恢复到随机临时库，完成后已删除。

## 结果

- 样本：100 页；分层 0=11、1-9=25、10-49=25、200+=14、50-199=25。
- 三方 rating 全一致：57；三方 rating+active 全一致：57。
- 全量已删页 legacy rating 对账：6604/6629 (99.6229%)。
- 全量已删页归档 rating 对账：10893/11238 (96.9301%)。
- 归档不一致 345 页归因：archive_pre_vote_resync_snapshot_confirmed_by_legacy=247；legacy_terminal_unavailable_pre_resync_delta=49；legacy_vote_history_terminal_absent_from_votes_snapshot=4；page_changed_after_dump=45。
- 样本归因：all_three_equal=57；archive_pre_vote_resync_snapshot_confirmed_by_legacy=18；legacy_unavailable_current_archive_equal=24；page_changed_after_dump_legacy_unavailable=1。

完整机器可读结果见 `s3-deleted-signoff-2026-07-28.json`。

| page_id | slug | 层 | C3 | v1 r/a | legacy r/a | archive r/a | rating 一致 | state 一致 | 归因 |
|---:|---|---|---:|---:|---:|---:|---|---|---|
| 1224 | http://scp-wiki-cn.wikidot.com/anchor-guide | 50-199 | 1 | -40/120 | N/A | 36/44 | N/A | N/A | page_changed_after_dump_legacy_unavailable |
| 17364 | http://scp-wiki-cn.wikidot.com/scp-3977 | 0 | 0 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 22172 | http://scp-wiki-cn.wikidot.com/scp-cn-1581 | 10-49 | 0 | 0/30 | N/A | 0/30 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 23723 | http://scp-wiki-cn.wikidot.com/scp-cn-2968 | 50-199 | 3 | -2/68 | N/A | -2/68 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 28543 | http://scp-wiki-cn.wikidot.com/toohot | 10-49 | 0 | -1/25 | N/A | -1/25 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 31615 | http://scp-wiki-cn.wikidot.com/cn-writers-fantasy | 200+ | 1 | 927/977 | N/A | 927/977 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 33556 | http://scp-wiki-cn.wikidot.com/book-bug | 1-9 | 0 | -4/6 | N/A | -4/6 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 33574 | http://scp-wiki-cn.wikidot.com/fcv | 50-199 | 1 | -40/66 | N/A | -40/66 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 33758 | http://scp-wiki-cn.wikidot.com/wanderers:the-day | 10-49 | 0 | 16/20 | N/A | 16/20 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 34110 | http://scp-wiki-cn.wikidot.com/scp-cn-3942 | 1-9 | 0 | -9/9 | N/A | -9/9 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 91712 | https://scp-wiki-cn.wikidot.com/tanwan | 50-199 | 0 | 8/54 | 8/54 | 8/54 | yes | yes | all_three_equal |
| 91817 | https://scp-wiki-cn.wikidot.com/scp-cn-994 | 200+ | 0 | 891/981 | 891/981 | 873/981 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 91982 | https://scp-wiki-cn.wikidot.com/gec-hub-page | 200+ | 0 | 215/229 | 215/229 | 215/229 | yes | yes | all_three_equal |
| 92079 | https://scp-wiki-cn.wikidot.com/scp-cn-840 | 10-49 | 0 | 14/16 | 14/16 | 14/16 | yes | yes | all_three_equal |
| 92082 | https://scp-wiki-cn.wikidot.com/scp-cn-704 | 10-49 | 0 | -5/11 | -5/11 | -5/11 | yes | yes | all_three_equal |
| 92130 | https://scp-wiki-cn.wikidot.com/scp-cn-590 | 10-49 | 874 | -14/14 | -14/14 | -8/14 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 92218 | https://scp-wiki-cn.wikidot.com/bad-supervisor-1 | 1-9 | 0 | -4/6 | -4/6 | -4/6 | yes | yes | all_three_equal |
| 92306 | https://scp-wiki-cn.wikidot.com/scp-cn-967 | 50-199 | 0 | -53/53 | -53/53 | -53/53 | yes | yes | all_three_equal |
| 92398 | https://scp-wiki-cn.wikidot.com/scp-cn-506-1 | 1-9 | 0 | 0/2 | 0/2 | 0/2 | yes | yes | all_three_equal |
| 92472 | https://scp-wiki-cn.wikidot.com/who-is-next | 1-9 | 0 | -2/6 | -2/6 | -2/6 | yes | yes | all_three_equal |
| 92520 | https://scp-wiki-cn.wikidot.com/scp-cn-643 | 50-199 | 0 | -55/57 | -55/57 | -55/57 | yes | yes | all_three_equal |
| 92521 | https://scp-wiki-cn.wikidot.com/scp-cn-496 | 50-199 | 0 | -4/52 | -4/52 | -4/52 | yes | yes | all_three_equal |
| 92576 | https://scp-wiki-cn.wikidot.com/scp-cn-590 | 10-49 | 865 | -5/13 | -5/13 | -3/13 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 92644 | https://scp-wiki-cn.wikidot.com/scp-cn-590 | 10-49 | 864 | -4/22 | -4/22 | 6/22 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 92702 | https://scp-wiki-cn.wikidot.com/scp-cn-590 | 1-9 | 864 | -4/6 | -4/6 | 0/6 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 92707 | https://scp-wiki-cn.wikidot.com/scp-cn-569 | 1-9 | 0 | -8/8 | -8/8 | -8/8 | yes | yes | all_three_equal |
| 92719 | https://scp-wiki-cn.wikidot.com/scp-cn-566 | 10-49 | 0 | -14/16 | -14/16 | -14/16 | yes | yes | all_three_equal |
| 92768 | https://scp-wiki-cn.wikidot.com/scp-cn-590 | 10-49 | 869 | -9/11 | -9/11 | -1/11 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 92943 | https://scp-wiki-cn.wikidot.com/exposition | 10-49 | 0 | 44/48 | 44/48 | 44/48 | yes | yes | all_three_equal |
| 93012 | https://scp-wiki-cn.wikidot.com/scp-cn-1000 | 10-49 | 2478 | 33/43 | 33/43 | 37/43 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 93194 | https://scp-wiki-cn.wikidot.com/porn-hub-page | 200+ | 0 | 695/737 | 695/737 | 695/737 | yes | yes | all_three_equal |
| 93317 | https://scp-wiki-cn.wikidot.com/scp-cn-1019 | 1-9 | 0 | -6/8 | -6/8 | -6/8 | yes | yes | all_three_equal |
| 93354 | https://scp-wiki-cn.wikidot.com/scp-cn-1199 | 10-49 | 1034 | 0/14 | 0/14 | 2/14 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 93365 | https://scp-wiki-cn.wikidot.com/scp-cn-1504 | 1-9 | 0 | -7/9 | -7/9 | -7/9 | yes | yes | all_three_equal |
| 93719 | https://scp-wiki-cn.wikidot.com/scp-3333:log-3 | 0 | 0 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 93791 | https://scp-wiki-cn.wikidot.com/ci:start | 1-9 | 0 | 2/2 | 2/2 | 2/2 | yes | yes | all_three_equal |
| 94099 | https://scp-wiki-cn.wikidot.com/scp-cn-1109 | 1-9 | 3240 | -3/9 | -3/9 | 1/9 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 94132 | https://scp-wiki-cn.wikidot.com/scp-cn-1147-01 | 1-9 | 0 | -3/7 | -3/7 | -3/7 | yes | yes | all_three_equal |
| 94353 | https://scp-wiki-cn.wikidot.com/scp-cn-1109 | 50-199 | 3292 | -55/55 | -55/55 | -9/55 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 94664 | https://scp-wiki-cn.wikidot.com/damengchuxing | 10-49 | 0 | 13/17 | 13/17 | 13/17 | yes | yes | all_three_equal |
| 94837 | https://scp-wiki-cn.wikidot.com/w-asriel-is-so-sexy | 200+ | 0 | 240/300 | 240/300 | 240/300 | yes | yes | all_three_equal |
| 94875 | https://scp-wiki-cn.wikidot.com/fragment:as-clouds-and-rain-clear-28 | 0 | 0 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 94966 | https://scp-wiki-cn.wikidot.com/scp-cn-1065 | 10-49 | 0 | -11/13 | -11/13 | -11/13 | yes | yes | all_three_equal |
| 95041 | https://scp-wiki-cn.wikidot.com/scp-5000 | 200+ | 497 | 375/383 | 375/383 | 377/383 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 95231 | https://scp-wiki-cn.wikidot.com/scp-cn-1791 | 1-9 | 0 | -6/8 | -6/8 | -6/8 | yes | yes | all_three_equal |
| 95313 | https://scp-wiki-cn.wikidot.com/blasphemous | 200+ | 0 | 365/377 | 365/377 | 365/377 | yes | yes | all_three_equal |
| 95359 | https://scp-wiki-cn.wikidot.com/scp-cn-2000 | 0 | 4916 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 95463 | https://scp-wiki-cn.wikidot.com/scp-cn-1904 | 50-199 | 0 | 27/55 | 27/55 | 27/55 | yes | yes | all_three_equal |
| 95515 | https://scp-wiki-cn.wikidot.com/uiu-sexy-uiu-girl | 200+ | 0 | 272/372 | 272/372 | 272/372 | yes | yes | all_three_equal |
| 95532 | https://scp-wiki-cn.wikidot.com/happyeatomatogirlwife | 50-199 | 0 | 26/60 | 26/60 | 26/60 | yes | yes | all_three_equal |
| 95732 | https://scp-wiki-cn.wikidot.com/shoot-in-your-underwear | 200+ | 0 | 332/392 | 332/392 | 332/392 | yes | yes | all_three_equal |
| 95760 | https://scp-wiki-cn.wikidot.com/the-glory-of-the-god-of-down-shines-upon-the-earth | 50-199 | 0 | 28/60 | 28/60 | 28/60 | yes | yes | all_three_equal |
| 95807 | https://scp-wiki-cn.wikidot.com/scp-4303 | 1-9 | 0 | -5/5 | -5/5 | -5/5 | yes | yes | all_three_equal |
| 95929 | https://scp-wiki-cn.wikidot.com/scp-cn-2000 | 1-9 | 4918 | -2/2 | -2/2 | 2/2 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 95958 | https://scp-wiki-cn.wikidot.com/scp-cn-1266 | 50-199 | 0 | -3/51 | -3/51 | -3/51 | yes | yes | all_three_equal |
| 95991 | https://scp-wiki-cn.wikidot.com/scp-cn-1422 | 10-49 | 0 | 30/44 | 30/44 | 30/44 | yes | yes | all_three_equal |
| 96054 | https://scp-wiki-cn.wikidot.com/cn10-gkly01 | 50-199 | 0 | -17/83 | -17/83 | -17/83 | yes | yes | all_three_equal |
| 96126 | https://scp-wiki-cn.wikidot.com/scp-cn-1271 | 50-199 | 0 | -8/52 | -8/52 | -8/52 | yes | yes | all_three_equal |
| 96179 | https://scp-wiki-cn.wikidot.com/log-of-anomalous-items-cn:00219 | 1-9 | 0 | -4/4 | -4/4 | -4/4 | yes | yes | all_three_equal |
| 96246 | https://scp-wiki-cn.wikidot.com/scp-cn-1730-ex | 10-49 | 0 | -7/45 | -7/45 | -7/45 | yes | yes | all_three_equal |
| 96390 | https://scp-wiki-cn.wikidot.com/scp-cn-2000 | 10-49 | 4927 | -11/11 | -11/11 | 1/11 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 96393 | https://scp-wiki-cn.wikidot.com/scp-cn-2000-edit | 1-9 | 0 | -1/1 | -1/1 | -1/1 | yes | yes | all_three_equal |
| 96431 | https://scp-wiki-cn.wikidot.com/scp-cn-2000 | 10-49 | 4932 | -16/16 | -16/16 | 2/16 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 96435 | https://scp-wiki-cn.wikidot.com/scp-cn-4000 | 0 | 1927 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 96530 | https://scp-wiki-cn.wikidot.com/my-knight | 200+ | 0 | 21/217 | 21/217 | 21/217 | yes | yes | all_three_equal |
| 96549 | https://scp-wiki-cn.wikidot.com/log-of-anomalous-items-cn:00345 | 1-9 | 0 | -5/9 | -5/9 | -5/9 | yes | yes | all_three_equal |
| 96657 | https://scp-wiki-cn.wikidot.com/shi-ti | 200+ | 0 | 255/293 | 255/293 | 255/293 | yes | yes | all_three_equal |
| 96779 | https://scp-wiki-cn.wikidot.com/live-in-death | 200+ | 0 | 285/301 | 285/301 | 285/301 | yes | yes | all_three_equal |
| 96909 | https://scp-wiki-cn.wikidot.com/wanderers:they-me-you-stars | 50-199 | 0 | 53/57 | 53/57 | 53/57 | yes | yes | all_three_equal |
| 96982 | https://scp-wiki-cn.wikidot.com/scp-3646 | 1-9 | 0 | 2/2 | 2/2 | 2/2 | yes | yes | all_three_equal |
| 97049 | https://scp-wiki-cn.wikidot.com/the-story-of-my-life | 50-199 | 0 | 66/78 | 66/78 | 66/78 | yes | yes | all_three_equal |
| 97051 | https://scp-wiki-cn.wikidot.com/sweet-dreams-and-flying-machines-in-pieces-on-the-ground | 1-9 | 0 | 9/9 | 9/9 | 9/9 | yes | yes | all_three_equal |
| 97306 | https://scp-wiki-cn.wikidot.com/wedding-ring | 50-199 | 0 | 2/50 | 2/50 | 2/50 | yes | yes | all_three_equal |
| 97320 | https://scp-wiki-cn.wikidot.com/short-stories:00111 | 1-9 | 0 | -1/1 | -1/1 | -1/1 | yes | yes | all_three_equal |
| 97434 | https://scp-wiki-cn.wikidot.com/my-last-childhood | 1-9 | 0 | 1/1 | 1/1 | 1/1 | yes | yes | all_three_equal |
| 98013 | https://scp-wiki-cn.wikidot.com/kib-u | 1-9 | 0 | -5/5 | -5/5 | -5/5 | yes | yes | all_three_equal |
| 98050 | https://scp-wiki-cn.wikidot.com/scp-cn-2877 | 10-49 | 0 | 8/22 | 8/22 | 8/22 | yes | yes | all_three_equal |
| 98102 | https://scp-wiki-cn.wikidot.com/scp-009-th | 1-9 | 0 | 3/5 | 3/5 | 3/5 | yes | yes | all_three_equal |
| 98123 | https://scp-wiki-cn.wikidot.com/scp-cn-1119 | 50-199 | 0 | 2/62 | 2/62 | 2/62 | yes | yes | all_three_equal |
| 98184 | https://scp-wiki-cn.wikidot.com/scp-cn-2753 | 50-199 | 0 | 0/54 | 0/54 | 0/54 | yes | yes | all_three_equal |
| 98261 | https://scp-wiki-cn.wikidot.com/scp-cn-2801 | 10-49 | 2914 | -18/26 | -18/26 | 6/26 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 98275 | https://scp-wiki-cn.wikidot.com/scp-cn-2801 | 50-199 | 2877 | 19/57 | 19/57 | 27/57 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 98433 | https://scp-wiki-cn.wikidot.com/wanderers:one-thousand-miles-for-snow | 10-49 | 0 | 32/32 | 32/32 | 32/32 | yes | yes | all_three_equal |
| 98458 | https://scp-wiki-cn.wikidot.com/scp-cn-2801 | 10-49 | 2920 | -24/24 | -24/24 | 8/24 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 98467 | https://scp-wiki-cn.wikidot.com/scp-cn-2787 | 10-49 | 6 | 20/24 | 20/24 | 18/24 | no | no | archive_pre_vote_resync_snapshot_confirmed_by_legacy |
| 98530 | https://scp-wiki-cn.wikidot.com/scp-cn-2151-j | 200+ | 0 | -31/203 | -31/203 | -31/203 | yes | yes | all_three_equal |
| 98580 | https://scp-wiki-cn.wikidot.com/scp-cn-2830 | 50-199 | 0 | 31/81 | 31/81 | 31/81 | yes | yes | all_three_equal |
| 98586 | https://scp-wiki-cn.wikidot.com/scp-cn-2889 | 10-49 | 35 | -13/13 | -13/13 | -13/13 | yes | yes | all_three_equal |
| 98680 | https://scp-wiki-cn.wikidot.com/short-stories:00251 | 1-9 | 0 | 1/1 | 1/1 | 1/1 | yes | yes | all_three_equal |
| 99639 | https://scp-wiki-cn.wikidot.com/scp-cn-3001 | 0 | 902 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 99710 | https://scp-wiki-cn.wikidot.com/scp-cn-2485 | 0 | 18 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 99937 | https://scp-wiki-cn.wikidot.com/huanianlikenose | 0 | 0 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 100138 | https://scp-wiki-cn.wikidot.com/scp-cn-3000 | 0 | 2024 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 100144 | https://scp-wiki-cn.wikidot.com/scp-cn-3000 | 0 | 2024 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 100760 | https://scp-wiki-cn.wikidot.com/wanderers:leaving-wind | 0 | 0 | 0/0 | N/A | 0/0 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 101150 | http://scp-wiki-cn.wikidot.com/scp-cn-3654 | 50-199 | 0 | -22/50 | N/A | -22/50 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 102384 | http://scp-wiki-cn.wikidot.com/scp-cn-4029 | 50-199 | 0 | -91/91 | N/A | -91/91 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 102781 | http://scp-wiki-cn.wikidot.com/my-dick-ass-ass-in-teacher | 200+ | 2 | -25/295 | N/A | -25/295 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 103712 | http://scp-wiki-cn.wikidot.com/scp-cn-4039 | 50-199 | 1 | -7/61 | N/A | -7/61 | N/A | N/A | legacy_unavailable_current_archive_equal |
| 104320 | http://scp-wiki-cn.wikidot.com/xueyutie1 | 50-199 | 0 | 28/64 | N/A | 28/64 | N/A | N/A | legacy_unavailable_current_archive_equal |
