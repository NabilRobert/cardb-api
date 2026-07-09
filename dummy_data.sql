-- Dummy test data to verify the schema works end-to-end.
-- Purely a structural test -- these are placeholder values, not real inventory data.

INSERT INTO uploads (filename)
VALUES ('test_upload.xlsx')
RETURNING id;

-- Note the id returned above, and use it in place of the subquery below
-- if you'd rather insert manually. This version does it in one go:
INSERT INTO vehicles (
    license_plate, vin, engine_no, brand, model_trim, year,
    transmission, color, odometer_km, stnk_expiry_date,
    status, reserved_by, location, ownership,
    price_cash, price_credit, max_credit_discount,
    notes_raw, source, upload_id, sheet_name, row_index
) VALUES (
    'TEST0001', 'TESTVIN0001', 'TESTENGINE0001', 'TestBrand', 'Test Model X', 2020,
    'Automatic', 'Test Color', 12345, '2027-01-01',
    'available', NULL, 'TESTLOC', 'Test Ownership',
    100000000, 110000000, NULL,
    'This is a dummy test row', 'Test source',
    (SELECT id FROM uploads WHERE filename = 'test_upload.xlsx' ORDER BY id DESC LIMIT 1),
    'TestSheet', 1
);

-- Verify:
-- SELECT * FROM uploads;
-- SELECT * FROM vehicles;
