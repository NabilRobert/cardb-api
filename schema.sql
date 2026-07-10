-- uploads: tracks each ingested Excel file
CREATE TABLE IF NOT EXISTS uploads (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rows_inserted INTEGER,      -- populated at insert time; NULL for uploads that predate this column
    rows_skipped INTEGER
);

-- vehicles: current snapshot, one row per physical unit
CREATE TABLE IF NOT EXISTS vehicles (
    id SERIAL PRIMARY KEY,
    license_plate TEXT,
    vin TEXT,
    engine_no TEXT,
    brand TEXT,
    model_trim TEXT,
    year INTEGER,
    transmission TEXT,
    color TEXT,
    odometer_km INTEGER,
    stnk_expiry_date DATE,
    stock_entry_date DATE,     -- date the unit entered stock (derived from "Age" column)
    status TEXT,               -- available / booked / sold
    reserved_by TEXT,          -- populated when status = booked
    location TEXT,             -- best-effort parsed area/branch, nullable
    ownership TEXT,
    price_cash NUMERIC,
    price_credit NUMERIC,
    max_credit_discount TEXT,
    notes_raw TEXT,            -- original "Keterangan" string, kept as-is
    source TEXT,               -- trade-in / acquisition provenance
    upload_id INTEGER REFERENCES uploads(id),
    sheet_name TEXT,
    row_index INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicles_brand ON vehicles (brand);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles (status);
CREATE INDEX IF NOT EXISTS idx_vehicles_location ON vehicles (location);
CREATE INDEX IF NOT EXISTS idx_vehicles_license_plate ON vehicles (license_plate);
CREATE INDEX IF NOT EXISTS idx_vehicles_stock_entry_date ON vehicles (stock_entry_date);

-- vehicle_transactions: history log per unit (purchase / sale / recon events)
CREATE TABLE IF NOT EXISTS vehicle_transactions (
    id SERIAL PRIMARY KEY,
    vehicle_id INTEGER REFERENCES vehicles(id),
    event_type TEXT,           -- purchase / sold / recon
    event_date DATE,
    purchase_price NUMERIC,
    recon_cost NUMERIC,
    selling_price_cash NUMERIC,
    selling_price_credit NUMERIC,
    gp_amount NUMERIC,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_transactions_vehicle_id ON vehicle_transactions (vehicle_id);
