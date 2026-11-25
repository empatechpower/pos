-- A member price beside an item's price in a pricebook (handout 3: "member prices apply automatically"). NULL = members pay the normal price.
ALTER TABLE pricebook_prices ADD COLUMN IF NOT EXISTS member_price_cents integer CHECK (member_price_cents IS NULL OR member_price_cents >= 0);
