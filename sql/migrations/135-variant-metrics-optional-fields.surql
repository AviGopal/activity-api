-- Migration 135: Make variant_performance_metrics confidence fields optional
-- SurrealDB 2.3.3 fires ASSERT before VALUE defaults, so TYPE float/int with
-- ASSERT rejects NONE even when VALUE $value OR <default> would supply a value.
-- Template registration (POST /v2/activities/templates) UPSERTs variant_performance_metrics
-- without confidence_interval/sample_size/is_deprecated, causing 500 errors.
-- Fix: drop ASSERT, use option<T> so absent fields pass validation.

DEFINE FIELD OVERWRITE confidence_interval ON variant_performance_metrics
  TYPE option<float>
  VALUE $value OR 0.0;

DEFINE FIELD OVERWRITE sample_size ON variant_performance_metrics
  TYPE option<int>
  VALUE $value OR 0;

DEFINE FIELD OVERWRITE is_deprecated ON variant_performance_metrics
  TYPE option<bool>
  VALUE $value OR false;
