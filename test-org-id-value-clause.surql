-- Test org_id VALUE clause behavior with RECORD authentication

-- First, authenticate as MiniBob to get $auth context
-- Run this via curl with proper auth

-- Test 1: Check what $auth contains
SELECT $auth AS full_auth, $auth.org_id AS org_id_field, type::thing($auth.org_id) AS coerced;

-- Test 2: Check string conversion options
SELECT 
  $auth.org_id AS raw,
  string($auth.org_id) AS string_cast,
  <string>$auth.org_id AS type_cast,
  type::is::string($auth.org_id) AS is_string;

-- Test 3: Simulate VALUE clause
SELECT 
  "explicit_value" OR $auth.org_id AS with_explicit,
  NONE OR $auth.org_id AS with_none;
