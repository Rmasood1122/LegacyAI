-- migrate:up

-- Decision D41, step 6 part 2: the title of a knowledge item and the words a stored conflict quotes from two items
-- are stored SEALED from now on, like the item's text: encrypted with the company's content key, bound to the company,
-- the table, the column and the row ("item:<id>", "conflict:<item id>:<other item id>"), with the key's name alongside.
-- Rows written before stay readable until the housekeeping job seals them; a value is readable or sealed, never both.
-- The measure of a conflict ("measure:pressure" ...) is a label from the check in code, not the item's words, and
-- stays readable. Only the AI service reads these columns.

-- ---------------------------------------------------------------- knowledge_items.title
ALTER TABLE knowledge_items
  ADD COLUMN title_sealed bytea CHECK (octet_length(title_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key   text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE knowledge_items ALTER COLUMN title DROP NOT NULL;
ALTER TABLE knowledge_items DROP CONSTRAINT knowledge_items_check;
ALTER TABLE knowledge_items ADD CONSTRAINT knowledge_items_title_form CHECK (
  (title_sealed IS NULL) = (sealed_key IS NULL)
  AND CASE
        WHEN title_sealed IS NOT NULL THEN title IS NULL                                        -- sealed
        ELSE char_length(title) BETWEEN 1 AND 200 OR (status = 'withdrawn' AND title = '')    -- readable, or erased
      END);

-- ---------------------------------------------------------------- knowledge_item_conflicts
ALTER TABLE knowledge_item_conflicts
  ADD COLUMN item_value_sealed  bytea CHECK (octet_length(item_value_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN other_value_sealed bytea CHECK (octet_length(other_value_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key         text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE knowledge_item_conflicts ALTER COLUMN item_value DROP NOT NULL, ALTER COLUMN other_value DROP NOT NULL;
ALTER TABLE knowledge_item_conflicts ADD CONSTRAINT knowledge_item_conflicts_value_form CHECK (
  (item_value_sealed IS NULL) = (sealed_key IS NULL) AND (other_value_sealed IS NULL) = (sealed_key IS NULL)
  AND (item_value IS NULL) = (item_value_sealed IS NOT NULL) AND (other_value IS NULL) = (other_value_sealed IS NOT NULL));

-- migrate:down
-- Refused while anything is sealed: the old schema cannot hold it.
DO $$
BEGIN
  ALTER TABLE knowledge_items NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE knowledge_item_conflicts NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM knowledge_items WHERE title_sealed IS NOT NULL)
     OR EXISTS (SELECT 1 FROM knowledge_item_conflicts WHERE sealed_key IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back sealed titles and conflicts: some are sealed';
  END IF;
  ALTER TABLE knowledge_items FORCE ROW LEVEL SECURITY;
  ALTER TABLE knowledge_item_conflicts FORCE ROW LEVEL SECURITY;
END
$$;
ALTER TABLE knowledge_item_conflicts DROP CONSTRAINT knowledge_item_conflicts_value_form;
ALTER TABLE knowledge_item_conflicts ALTER COLUMN item_value SET NOT NULL, ALTER COLUMN other_value SET NOT NULL;
ALTER TABLE knowledge_item_conflicts DROP COLUMN sealed_key, DROP COLUMN other_value_sealed, DROP COLUMN item_value_sealed;
ALTER TABLE knowledge_items DROP CONSTRAINT knowledge_items_title_form;
ALTER TABLE knowledge_items ALTER COLUMN title SET NOT NULL;
ALTER TABLE knowledge_items ADD CONSTRAINT knowledge_items_check
  CHECK (char_length(title) BETWEEN 1 AND 200 OR (status = 'withdrawn' AND title = ''));
ALTER TABLE knowledge_items DROP COLUMN sealed_key, DROP COLUMN title_sealed;
