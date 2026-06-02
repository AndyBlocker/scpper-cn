-- #106：统一检索字段 search_text 原仅含正文，按正文搜标签词/副标题(别名)召回不到。
-- 把 alternateTitle + tags 并入 search_text 构建，使其 pgroonga 索引同时覆盖标签/副标题检索。
-- 含：重写触发器函数 + refresh 函数 + 触发器(增监听 tags/alternateTitle 列) + 回填当前版本。

-- 1) BEFORE INSERT/UPDATE 触发器函数：search_text = 正文 + 副标题 + 标签(空格连接)
CREATE OR REPLACE FUNCTION public.trg_pageversion_set_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_body text;
BEGIN
  v_body := NULLIF(NEW."textContent", '');
  IF v_body IS NULL THEN
    SELECT COALESCE(NULLIF(s."textContent", ''), s.source)
    INTO v_body
    FROM "SourceVersion" s
    WHERE s."pageVersionId" = NEW.id
    ORDER BY s."isLatest" DESC, s.timestamp DESC
    LIMIT 1;
  END IF;

  NEW."search_text" := btrim(
    COALESCE(v_body, '')
    || ' ' || COALESCE(NEW."alternateTitle", '')
    || ' ' || array_to_string(COALESCE(NEW.tags, ARRAY[]::text[]), ' ')
  );

  IF NEW."search_text" IS NULL THEN
    NEW."search_text" := '';
  END IF;

  RETURN NEW;
END;
$$;

-- 2) 按需重算函数(供 SourceVersion 触发器调用)：同样并入副标题 + 标签
CREATE OR REPLACE FUNCTION public.refresh_pageversion_search_text(p_page_version_id integer)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_body text;
  v_alt  text;
  v_tags text;
BEGIN
  SELECT NULLIF(pv."textContent", ''),
         pv."alternateTitle",
         array_to_string(COALESCE(pv.tags, ARRAY[]::text[]), ' ')
  INTO v_body, v_alt, v_tags
  FROM "PageVersion" pv
  WHERE pv.id = p_page_version_id;

  IF v_body IS NULL THEN
    SELECT COALESCE(NULLIF(s."textContent", ''), s.source)
    INTO v_body
    FROM "SourceVersion" s
    WHERE s."pageVersionId" = p_page_version_id
    ORDER BY s."isLatest" DESC, s.timestamp DESC
    LIMIT 1;
  END IF;

  UPDATE "PageVersion"
  SET "search_text" = btrim(
    COALESCE(v_body, '')
    || ' ' || COALESCE(v_alt, '')
    || ' ' || COALESCE(v_tags, '')
  )
  WHERE id = p_page_version_id;
END;
$$;

-- 3) 触发器增加监听 alternateTitle / tags 列(原仅 textContent)，使标签/副标题变更也刷新 search_text
DROP TRIGGER IF EXISTS trg_pageversion_search_text ON "PageVersion";
CREATE TRIGGER trg_pageversion_search_text
BEFORE INSERT OR UPDATE OF "textContent", "alternateTitle", "tags"
ON "PageVersion"
FOR EACH ROW
EXECUTE FUNCTION public.trg_pageversion_set_search_text();

-- 4) 回填当前版本(validTo IS NULL)的 search_text 为新公式(正文 + 副标题 + 标签)
UPDATE "PageVersion" pv
SET "search_text" = btrim(
  COALESCE(
    NULLIF(pv."textContent", ''),
    (
      SELECT COALESCE(NULLIF(s."textContent", ''), s.source)
      FROM "SourceVersion" s
      WHERE s."pageVersionId" = pv.id
      ORDER BY s."isLatest" DESC, s.timestamp DESC
      LIMIT 1
    ),
    ''
  )
  || ' ' || COALESCE(pv."alternateTitle", '')
  || ' ' || array_to_string(COALESCE(pv.tags, ARRAY[]::text[]), ' ')
)
WHERE pv."validTo" IS NULL;
