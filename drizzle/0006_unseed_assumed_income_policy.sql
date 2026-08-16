-- Remove the Stage 12 bootstrap policy. ₹79,200 / days 4–8 is a test fixture, not user config.
DELETE FROM `income_policies`
WHERE `expected_amount_paise` = 7920000
  AND `window_start_day` = 4
  AND `window_end_day` = 8
  AND `typical_day` = 5
  AND `effective_from` = '2020-01-01'
  AND `effective_to` IS NULL;
