-- Members who may still spend their credit while the credit freeze is on.
CREATE TABLE IF NOT EXISTS credit_freeze_exempt (
  merchant_id text NOT NULL,
  member_id   text NOT NULL,
  PRIMARY KEY (merchant_id, member_id)
);
