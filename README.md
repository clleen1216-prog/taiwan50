# taiwan50 · 每日快照資料

這個分支（`data`）只放資料，由 GitHub Actions 每個交易日自動寫入。網站（`main` 分支）不會因為這裡的更新而重新部署。

## 檔案位置

| 路徑 | 內容 | 更新時間 |
|---|---|---|
| `data/tw/YYYY-MM.csv` | 台股 49 檔，每個交易日一列，所有特徵與分數 | 台北週一到週五 22:30 |
| `data/tw_sectors/YYYY-MM.csv` | 台股類股資金輪動（5 日 / 20 日成交值占比） | 同上 |
| `data/us/YYYY-MM.csv` | 美股 11 檔，每個交易日一列 | UTC 週一到週五 22:00（台北週二到週六清晨 6:00） |
| `data/us_etfs/YYYY-MM.csv` | 美股產業 ETF 相對強弱與量能 | 同上 |
| `data/labels/tw.csv`、`data/labels/us.csv` | 標籤：每筆快照 1 / 5 / 10 個交易日後的報酬、超額報酬 | 每次快照後重算 |

在手機上看：GitHub 網頁 → 切到 `data` 分支 → `data` 資料夾 → 點檔案，或用 Raw 按鈕下載。

## 設計原則

- **Point-in-time**：每個檔案列的是「當天收盤後當下看得到的數字」，不會事後回填修改。法人連續天數、融資、選擇權預期波動、內部人申報這些日後無法重建，所以每天存一次。
- **同一天同一檔重跑會覆寫**，以最後一次為準；不會重複。
- 資料不完整（台股低於 80% 檔數、美股低於 80%）時**不存檔**，排程會失敗並寄信通知，避免污染資料。
- 標籤用「往後第 N 筆快照」當作 N 個交易日後；如果中間缺資料（日曆天差距過大）該標籤留空，不會硬算。

## 欄位（台股 `tw`）

- 基本：`session_date`（行情日）、`code`、`name`、`sector`、`close`、`change_pct`、OHLC、`volume`
- 技術：`ma5/10/20/60`、`spread_pct`（均線糾結度 %）、`vol_ratio`（量比）、`upper_shadow`、`bearish`、`in_gate`、`tight`、`bull_stack`
- 分數：`sop_score`（原腳本分數，未入閘為空）、`sop_kind`、`flagship_score`
- 法人：`foreign`、`trust`、`dealer`（當日買賣超，單位股）、`foreign_streak`/`trust_streak`（連續買超為正、賣超為負的天數）、`foreign_5d`/`trust_5d`、`flow_days`
- 融資融券：`margin_bal`、`margin_chg`、`margin_chg_pct`、`margin_use`（使用率 %）、`short_bal`、`short_ratio`（券資比 %）、`margin_side`
- 千張大戶：`big_pct`（占比 %）、`big_change`（週變化，百分點）、`big_streak`（連續增減週數）、`holder_side`、`holder_date`（集保週報日）
- 其他：`sector_ratio`（類股資金 5 日 / 20 日）、`ret20/60`、`rs20`（相對 0050）、`pe/pb/div_yield`、`settlement`（是否週三結算日）、`bench_*`（0050）

## 欄位（美股 `us`）

基本與技術欄位同上，另有：`earnings_days`（距財報天數，空 = 未知）、`earnings_near`、`implied_move_pct`/`implied_iv`（財報 7 天內才有）、`insider_*`（內部人 Form 4）、`net_liq`/`net_liq_chg4w`/`net_liq_status`（淨流動性，十億美元）、`rrp`/`rrp_chg5d`、`bench_*`（SPY）。

## 注意

- 空白代表「當天沒取得」，不是 0。
- 只有快照開始之後的日子有資料；歷史資料另外回填。
- 這是研究資料，不是投資建議。
