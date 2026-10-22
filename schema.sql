-- =============================================================================
-- 哭包 · 智能客服 Agent —— 数据库结构与种子数据
-- -----------------------------------------------------------------------------
-- 目标库：PostgreSQL（WorkBuddy 云服务 / Supabase 风格，含 auth.uid() 可选）
-- 执行方式：
--   1) 云数据库 SQL 控制台可整体执行本文件；
--   2) 若平台限制「一次一条语句」，按 $$ ... $$ 分隔逐段执行（函数体内部不要拆）；
--   3) 种子数据中的口令为占位符，部署后请立即修改。
--   4) 本文件面向「空库首次安装」。重复执行不会覆盖已有口令，但 FAQ / 订单会插入重复行，
--      二次执行前请先清理 cs_faqs、cs_orders。
--
-- 安全模型：
--   除 cs_faqs 为公开只读外，其余表全部 ENABLE ROW LEVEL SECURITY 且不建策略，
--   匿名/登录用户直连查询恒为 0 行；所有读写都必须经过下方 SECURITY DEFINER 函数，
--   函数内部校验访客密钥（guest_key）或坐席/管理员口令后才落库。
-- =============================================================================


-- =============================== 1. 表结构 ==================================

CREATE TABLE cs_faqs (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question    TEXT        NOT NULL,
  answer      TEXT        NOT NULL,
  category    TEXT        NOT NULL DEFAULT 'general',   -- refund | order | tech | general
  keywords    TEXT        NOT NULL DEFAULT '',          -- 英文逗号分隔
  priority    INT         NOT NULL DEFAULT 0,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE cs_faqs IS 'FAQ 知识库：公开只读，管理端可增删改';

CREATE TABLE cs_orders (
  order_no    TEXT PRIMARY KEY,
  item        TEXT        NOT NULL,
  amount      NUMERIC(10, 2) NOT NULL,
  status      TEXT        NOT NULL,
  carrier     TEXT,
  tracking_no TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  shipped_at  TIMESTAMPTZ,
  eta         DATE
);
COMMENT ON TABLE cs_orders IS '演示订单数据，仅可通过 cs_lookup_order 查询';

CREATE TABLE cs_conversations (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guest_key       TEXT        NOT NULL,
  user_label      TEXT,
  channel         TEXT        NOT NULL DEFAULT 'web',
  status          TEXT        NOT NULL DEFAULT 'active',  -- active | handoff | closed
  intent          TEXT,                                   -- refund | order | tech | other
  intent_score    NUMERIC(4, 3),
  satisfaction    INT,                                    -- 1..5
  feedback        TEXT,
  contact         TEXT,                                   -- 非工作时间留言的联系方式
  message_count   INT         NOT NULL DEFAULT 0,
  handoff_at      TIMESTAMPTZ,
  assignee_id     BIGINT,                                 -- 认领坐席（0 = 管理员）
  assignee_name   TEXT,
  claimed_at      TIMESTAMPTZ,
  summary         TEXT,                                   -- 长会话摘要
  summary_upto_id BIGINT,
  summary_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE cs_conversations IS '会话主表：状态机 active → handoff → closed';

CREATE TABLE cs_messages (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT      NOT NULL REFERENCES cs_conversations(id) ON DELETE CASCADE,
  role            TEXT        NOT NULL,                   -- user | assistant | agent | system
  content         TEXT        NOT NULL,
  intent          TEXT,
  meta            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE cs_messages IS '消息表，meta 里存 faq_miss / agent_name / order_no 等标记';

CREATE TABLE cs_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE cs_settings IS '服务端配置，例如 admin_code';

CREATE TABLE cs_agents (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT        NOT NULL,
  code         TEXT        NOT NULL UNIQUE,               -- 工号口令
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);
COMMENT ON TABLE cs_agents IS '坐席账号：工号口令用于工作台登录';

CREATE TABLE cs_login_attempts (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_hash  TEXT        NOT NULL,                        -- md5(口令)，不存明文
  ok         BOOLEAN     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE cs_login_attempts IS '登录尝试审计，用于防爆破（按口令与全局双维度计数）';

CREATE INDEX cs_conversations_guest_idx ON cs_conversations (guest_key, updated_at DESC);
CREATE INDEX cs_messages_conv_idx       ON cs_messages (conversation_id, id);


-- ============================ 2. 权限与 RLS =================================

ALTER TABLE cs_faqs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_agents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cs_login_attempts ENABLE ROW LEVEL SECURITY;

-- 只有 FAQ 对匿名开放只读；其余表不建任何策略 = 直连一律拒绝
GRANT SELECT ON TABLE public.cs_faqs TO authenticated, anon;

CREATE POLICY cs_faqs_read ON cs_faqs
  FOR SELECT TO authenticated, anon
  USING (enabled = true);


-- ============================== 3. 函数层 ===================================

-- 3.1 统一身份解析：管理员（operator_id = 0）或坐席
CREATE OR REPLACE FUNCTION cs_operator(p_code text)
RETURNS TABLE(operator_id bigint, operator_name text, is_admin boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 0::bigint AS operator_id, '管理员'::text AS operator_name, true AS is_admin
   WHERE EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code)
  UNION ALL
  SELECT a.id, a.name, false FROM cs_agents a WHERE a.code = p_code AND a.is_active
$$;

-- 3.2 工作台登录（含防爆破：同口令 5 次 / 全局 20 次，10 分钟窗口）
CREATE OR REPLACE FUNCTION cs_console_login(p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id bigint; v_name text; v_admin boolean;
  v_global_fail int; v_code_fail int;
BEGIN
  DELETE FROM cs_login_attempts WHERE created_at < now() - interval '1 day';

  SELECT count(*) INTO v_global_fail FROM cs_login_attempts
   WHERE ok = false AND created_at > now() - interval '10 minutes';
  IF v_global_fail >= 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  END IF;

  SELECT count(*) INTO v_code_fail FROM cs_login_attempts
   WHERE ok = false AND code_hash = md5(coalesce(p_code, ''))
     AND created_at > now() - interval '10 minutes';
  IF v_code_fail >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  END IF;

  SELECT o.operator_id, o.operator_name, o.is_admin INTO v_id, v_name, v_admin FROM cs_operator(p_code) o;
  IF NOT FOUND THEN
    PERFORM pg_sleep(0.2);
    INSERT INTO cs_login_attempts (code_hash, ok) VALUES (md5(coalesce(p_code, '')), false);
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  INSERT INTO cs_login_attempts (code_hash, ok) VALUES (md5(coalesce(p_code, '')), true);
  IF v_id > 0 THEN
    UPDATE cs_agents SET last_seen_at = now() WHERE id = v_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'agent_id', v_id, 'name', v_name, 'is_admin', v_admin);
END $$;

-- 3.3 开启会话（写入欢迎语）
CREATE OR REPLACE FUNCTION cs_guest_start(p_guest_key text, p_user_label text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint;
BEGIN
  IF p_guest_key IS NULL OR length(p_guest_key) < 12 THEN
    RAISE EXCEPTION 'invalid guest key';
  END IF;
  INSERT INTO cs_conversations (guest_key, user_label, status)
  VALUES (p_guest_key, NULLIF(btrim(coalesce(p_user_label, '')), ''), 'active')
  RETURNING id INTO v_id;
  INSERT INTO cs_messages (conversation_id, role, content, intent, meta)
  VALUES (v_id, 'assistant', '您好，我是哭包～ 退款、订单查询、技术支持都可以问我。请直接描述您遇到的问题。', 'other', '{"kind":"welcome"}'::jsonb);
  UPDATE cs_conversations SET message_count = 1, updated_at = now() WHERE id = v_id;
  RETURN jsonb_build_object('ok', true, 'conversation_id', v_id);
END $$;

-- 3.4 本机访客的会话列表
CREATE OR REPLACE FUNCTION cs_guest_list(p_guest_key text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('ok', true, 'items', coalesce(jsonb_agg(x ORDER BY x.updated_at DESC), '[]'::jsonb))
  FROM (
    SELECT c.id, c.status, c.intent, c.satisfaction, c.message_count, c.created_at, c.updated_at,
           (SELECT m.content FROM cs_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
    FROM cs_conversations c
    WHERE c.guest_key = p_guest_key
    ORDER BY c.updated_at DESC
    LIMIT 30
  ) x
$$;

-- 3.5 会话全部消息（校验归属）
CREATE OR REPLACE FUNCTION cs_guest_messages(p_guest_key text, p_conversation_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_conversations WHERE id = p_conversation_id AND guest_key = p_guest_key) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conversation not found');
  END IF;
  RETURN jsonb_build_object('ok', true, 'items', (
    SELECT coalesce(jsonb_agg(x ORDER BY x.id), '[]'::jsonb) FROM (
      SELECT id, role, content, intent, meta, created_at FROM cs_messages
       WHERE conversation_id = p_conversation_id ORDER BY id
    ) x));
END $$;

-- 3.6 写入消息（含限流：每访客每分钟 12 条）
CREATE OR REPLACE FUNCTION cs_guest_append(
  p_guest_key text, p_conversation_id bigint, p_role text, p_content text,
  p_intent text DEFAULT NULL, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint; v_recent int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_conversations WHERE id = p_conversation_id AND guest_key = p_guest_key) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conversation not found');
  END IF;
  IF p_role = 'user' THEN
    SELECT count(*) INTO v_recent
      FROM cs_messages m JOIN cs_conversations c ON c.id = m.conversation_id
     WHERE c.guest_key = p_guest_key AND m.role = 'user'
       AND m.created_at > now() - interval '60 seconds';
    IF v_recent >= 12 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
    END IF;
  END IF;
  INSERT INTO cs_messages (conversation_id, role, content, intent, meta)
  VALUES (p_conversation_id, p_role, left(coalesce(p_content, ''), 8000), p_intent, coalesce(p_meta, '{}'::jsonb))
  RETURNING id INTO v_id;
  UPDATE cs_conversations
     SET message_count = message_count + 1, intent = coalesce(p_intent, intent), updated_at = now()
   WHERE id = p_conversation_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- 3.7 更新会话状态 / 意图
CREATE OR REPLACE FUNCTION cs_guest_update(
  p_guest_key text, p_conversation_id bigint,
  p_status text DEFAULT NULL, p_intent text DEFAULT NULL, p_intent_score numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE cs_conversations
     SET status = coalesce(p_status, status),
         intent = coalesce(p_intent, intent),
         intent_score = coalesce(p_intent_score, intent_score),
         handoff_at = CASE WHEN p_status = 'handoff' AND handoff_at IS NULL THEN now() ELSE handoff_at END,
         updated_at = now()
   WHERE id = p_conversation_id AND guest_key = p_guest_key;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- 3.8 满意度评价
CREATE OR REPLACE FUNCTION cs_guest_rate(
  p_guest_key text, p_conversation_id bigint, p_score int, p_feedback text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_score IS NULL OR p_score < 1 OR p_score > 5 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'score must be between 1 and 5');
  END IF;
  UPDATE cs_conversations
     SET satisfaction = p_score,
         feedback = NULLIF(btrim(coalesce(p_feedback, '')), ''),
         updated_at = now()
   WHERE id = p_conversation_id AND guest_key = p_guest_key;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- 3.9 增量轮询（状态 + 坐席 + 摘要 + 新消息）
CREATE OR REPLACE FUNCTION cs_guest_poll(
  p_guest_key text, p_conversation_id bigint, p_after_id bigint DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status text; v_aname text; v_summary text; v_upto bigint;
BEGIN
  SELECT status, assignee_name, summary, summary_upto_id
    INTO v_status, v_aname, v_summary, v_upto
    FROM cs_conversations WHERE id = p_conversation_id AND guest_key = p_guest_key;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conversation not found');
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'assignee_name', v_aname,
    'summary', v_summary, 'summary_upto_id', coalesce(v_upto, 0), 'items', (
    SELECT coalesce(jsonb_agg(x ORDER BY x.id), '[]'::jsonb) FROM (
      SELECT id, role, content, intent, meta, created_at FROM cs_messages
       WHERE conversation_id = p_conversation_id AND id > coalesce(p_after_id, 0) ORDER BY id
    ) x));
END $$;

-- 3.10 非工作时间留言
CREATE OR REPLACE FUNCTION cs_guest_contact(
  p_guest_key text, p_conversation_id bigint, p_contact text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE cs_conversations
     SET contact = left(btrim(coalesce(p_contact, '')), 120), updated_at = now()
   WHERE id = p_conversation_id AND guest_key = p_guest_key;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- 3.11 保存长会话摘要
CREATE OR REPLACE FUNCTION cs_guest_summary_save(
  p_guest_key text, p_conversation_id bigint, p_summary text, p_upto_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(btrim(p_summary), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty summary');
  END IF;
  UPDATE cs_conversations
     SET summary = left(btrim(p_summary), 1500),
         summary_upto_id = greatest(coalesce(summary_upto_id, 0), coalesce(p_upto_id, 0)),
         summary_at = now()
   WHERE id = p_conversation_id AND guest_key = p_guest_key;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- 3.12 订单查询（演示数据）
CREATE OR REPLACE FUNCTION cs_lookup_order(p_order_no text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(t) FROM (
    SELECT order_no, item, amount, status, carrier, tracking_no, created_at, shipped_at, eta
    FROM cs_orders WHERE order_no = upper(btrim(coalesce(p_order_no, '')))
  ) t
$$;

-- 3.13 工单队列
CREATE OR REPLACE FUNCTION cs_agent_queue(p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint; v_name text; v_admin boolean;
BEGIN
  SELECT o.operator_id, o.operator_name, o.is_admin INTO v_id, v_name, v_admin FROM cs_operator(p_code) o;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;
  IF v_id > 0 THEN UPDATE cs_agents SET last_seen_at = now() WHERE id = v_id; END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'me', jsonb_build_object('id', v_id, 'name', v_name, 'is_admin', v_admin),
    'waiting', (SELECT coalesce(jsonb_agg(t ORDER BY t.wait_seconds DESC), '[]'::jsonb) FROM (
      SELECT c.id, coalesce(c.user_label, '访客') AS user_label, c.intent, c.status, c.contact,
             c.handoff_at, c.message_count, c.satisfaction,
             floor(extract(epoch FROM (now() - coalesce(c.handoff_at, c.updated_at))))::int AS wait_seconds,
             (SELECT m.content FROM cs_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
        FROM cs_conversations c
       WHERE c.status = 'handoff' AND c.assignee_id IS NULL
    ) t),
    'mine', (SELECT coalesce(jsonb_agg(t ORDER BY t.claimed_at), '[]'::jsonb) FROM (
      SELECT c.id, coalesce(c.user_label, '访客') AS user_label, c.intent, c.status, c.contact,
             c.claimed_at, c.message_count, c.satisfaction,
             floor(extract(epoch FROM (now() - coalesce(c.claimed_at, c.updated_at))))::int AS wait_seconds,
             (SELECT m.content FROM cs_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
        FROM cs_conversations c
       WHERE c.status = 'handoff' AND c.assignee_id = v_id
    ) t),
    'others', (SELECT coalesce(jsonb_agg(t ORDER BY t.claimed_at), '[]'::jsonb) FROM (
      SELECT c.id, coalesce(c.user_label, '访客') AS user_label, c.intent, c.assignee_name, c.claimed_at,
             floor(extract(epoch FROM (now() - coalesce(c.claimed_at, c.updated_at))))::int AS wait_seconds
        FROM cs_conversations c
       WHERE c.status = 'handoff' AND c.assignee_id IS NOT NULL AND c.assignee_id <> v_id
    ) t),
    'resolved_today', (SELECT count(*) FROM cs_conversations c
                        WHERE c.status = 'closed' AND c.updated_at::date = current_date)
  );
END $$;

-- 3.14 认领工单
CREATE OR REPLACE FUNCTION cs_agent_claim(p_code text, p_conversation_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint; v_name text; v_admin boolean; v_assignee bigint; v_aname text;
BEGIN
  SELECT o.operator_id, o.operator_name, o.is_admin INTO v_id, v_name, v_admin FROM cs_operator(p_code) o;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;

  SELECT c.assignee_id, c.assignee_name INTO v_assignee, v_aname
    FROM cs_conversations c WHERE c.id = p_conversation_id AND c.status = 'handoff';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_in_queue');
  END IF;
  IF v_assignee IS NOT NULL AND v_assignee <> v_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'claimed_by_other', 'assignee', coalesce(v_aname, '其他客服'));
  END IF;

  UPDATE cs_conversations
     SET assignee_id = v_id, assignee_name = v_name,
         claimed_at = coalesce(claimed_at, now()), updated_at = now()
   WHERE id = p_conversation_id;
  RETURN jsonb_build_object('ok', true, 'assignee', v_name);
END $$;

-- 3.15 释放工单
CREATE OR REPLACE FUNCTION cs_agent_release(p_code text, p_conversation_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint; v_name text; v_admin boolean;
BEGIN
  SELECT o.operator_id, o.operator_name, o.is_admin INTO v_id, v_name, v_admin FROM cs_operator(p_code) o;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;
  UPDATE cs_conversations
     SET assignee_id = NULL, assignee_name = NULL, claimed_at = NULL, updated_at = now()
   WHERE id = p_conversation_id AND assignee_id = v_id AND status = 'handoff';
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- 3.16 坐席视角的会话详情
CREATE OR REPLACE FUNCTION cs_agent_messages(p_code text, p_conversation_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint; v_name text; v_admin boolean; v_conv jsonb; v_items jsonb;
BEGIN
  SELECT o.operator_id, o.operator_name, o.is_admin INTO v_id, v_name, v_admin FROM cs_operator(p_code) o;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;

  SELECT jsonb_build_object('id', c.id, 'status', c.status, 'intent', c.intent, 'satisfaction', c.satisfaction,
                            'feedback', c.feedback, 'contact', c.contact, 'created_at', c.created_at,
                            'user_label', c.user_label, 'assignee_id', c.assignee_id,
                            'assignee_name', c.assignee_name, 'claimed_at', c.claimed_at,
                            'summary', c.summary, 'summary_upto_id', c.summary_upto_id)
    INTO v_conv FROM cs_conversations c WHERE c.id = p_conversation_id;
  IF v_conv IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conversation not found');
  END IF;

  SELECT coalesce(jsonb_agg(x ORDER BY x.id), '[]'::jsonb) INTO v_items FROM (
    SELECT id, role, content, intent, meta, created_at FROM cs_messages
     WHERE conversation_id = p_conversation_id ORDER BY id
  ) x;

  RETURN jsonb_build_object('ok', true, 'me', jsonb_build_object('id', v_id, 'name', v_name, 'is_admin', v_admin),
                            'conversation', v_conv, 'items', v_items);
END $$;

-- 3.17 坐席回复（消息 meta 记录工号姓名，未认领则自动认领）
CREATE OR REPLACE FUNCTION cs_agent_reply(p_code text, p_conversation_id bigint, p_content text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint; v_name text; v_admin boolean; v_msg_id bigint;
BEGIN
  SELECT o.operator_id, o.operator_name, o.is_admin INTO v_id, v_name, v_admin FROM cs_operator(p_code) o;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;
  IF coalesce(btrim(p_content), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty content');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cs_conversations WHERE id = p_conversation_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conversation not found');
  END IF;

  INSERT INTO cs_messages (conversation_id, role, content, meta)
  VALUES (p_conversation_id, 'agent', left(p_content, 4000),
          jsonb_build_object('kind', 'agent', 'agent_name', v_name))
  RETURNING id INTO v_msg_id;

  UPDATE cs_conversations
     SET message_count = message_count + 1,
         updated_at = now(),
         assignee_id = coalesce(assignee_id, v_id),
         assignee_name = coalesce(assignee_name, v_name),
         claimed_at = coalesce(claimed_at, now())
   WHERE id = p_conversation_id;

  RETURN jsonb_build_object('ok', true, 'id', v_msg_id, 'agent_name', v_name);
END $$;

-- 3.18 坐席标记解决
CREATE OR REPLACE FUNCTION cs_agent_resolve(p_code text, p_conversation_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint; v_name text; v_admin boolean;
BEGIN
  SELECT o.operator_id, o.operator_name, o.is_admin INTO v_id, v_name, v_admin FROM cs_operator(p_code) o;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;

  UPDATE cs_conversations
     SET status = 'closed', updated_at = now(),
         assignee_id = coalesce(assignee_id, v_id),
         assignee_name = coalesce(assignee_name, v_name),
         claimed_at = coalesce(claimed_at, now())
   WHERE id = p_conversation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conversation not found');
  END IF;

  INSERT INTO cs_messages (conversation_id, role, content, meta)
  VALUES (p_conversation_id, 'system', '本会话已由人工客服 ' || v_name || ' 处理完毕。',
          jsonb_build_object('kind', 'resolved', 'agent_name', v_name));
  RETURN jsonb_build_object('ok', true);
END $$;

-- 3.19 满意度与运营统计
CREATE OR REPLACE FUNCTION cs_admin_stats(p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  SELECT jsonb_build_object(
    'ok', true,
    'total_conversations', (SELECT count(*) FROM cs_conversations),
    'total_messages', (SELECT count(*) FROM cs_messages),
    'today_conversations', (SELECT count(*) FROM cs_conversations WHERE created_at::date = current_date),
    'rated_count', (SELECT count(*) FROM cs_conversations WHERE satisfaction IS NOT NULL),
    'avg_score', (SELECT round(coalesce(avg(satisfaction), 0)::numeric, 2) FROM cs_conversations WHERE satisfaction IS NOT NULL),
    'satisfied_rate', (SELECT coalesce(round((count(*) FILTER (WHERE satisfaction >= 4))::numeric * 100 / nullif(count(*), 0), 1), 0) FROM cs_conversations WHERE satisfaction IS NOT NULL),
    'handoff_count', (SELECT count(*) FROM cs_conversations WHERE handoff_at IS NOT NULL),
    'pending_handoff', (SELECT count(*) FROM cs_conversations WHERE status = 'handoff'),
    'score_dist', (
      SELECT coalesce(jsonb_object_agg(q.s::text, q.cnt), '{}'::jsonb)
      FROM (SELECT g.s, count(c.satisfaction) AS cnt
              FROM generate_series(1, 5) AS g(s)
              LEFT JOIN cs_conversations c ON c.satisfaction = g.s
             GROUP BY g.s ORDER BY g.s) q),
    'intent_counts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('intent', q.intent, 'count', q.cnt) ORDER BY q.cnt DESC), '[]'::jsonb)
      FROM (SELECT coalesce(intent, 'unknown') AS intent, count(*) AS cnt FROM cs_conversations GROUP BY coalesce(intent, 'unknown')) q),
    'status_counts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('status', q.status, 'count', q.cnt) ORDER BY q.cnt DESC), '[]'::jsonb)
      FROM (SELECT status, count(*) AS cnt FROM cs_conversations GROUP BY status) q),
    'daily', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('day', d.gd, 'conversations', d.cnt, 'rated', d.rcnt, 'avg_score', d.ascore) ORDER BY d.gd), '[]'::jsonb)
      FROM (
        SELECT gs::date AS gd,
          (SELECT count(*) FROM cs_conversations c WHERE c.created_at::date = gs::date) AS cnt,
          (SELECT count(*) FROM cs_conversations c WHERE c.created_at::date = gs::date AND c.satisfaction IS NOT NULL) AS rcnt,
          (SELECT round(coalesce(avg(c.satisfaction), 0)::numeric, 2) FROM cs_conversations c WHERE c.created_at::date = gs::date AND c.satisfaction IS NOT NULL) AS ascore
        FROM generate_series(current_date - 13, current_date, interval '1 day') gs
      ) d)
  ) INTO v_res;
  RETURN v_res;
END $$;

-- 3.20 会话列表（管理端分页）
CREATE OR REPLACE FUNCTION cs_admin_conversations(
  p_code text, p_status text DEFAULT 'all', p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_items jsonb; v_total bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  SELECT count(*) INTO v_total FROM cs_conversations c
   WHERE coalesce(p_status, 'all') = 'all' OR c.status = p_status;
  SELECT coalesce(jsonb_agg(x ORDER BY x.updated_at DESC), '[]'::jsonb) INTO v_items FROM (
    SELECT c.id, left(c.guest_key, 8) || '***' AS guest_key_mask, c.user_label, c.status, c.intent,
           c.satisfaction, c.feedback, c.message_count, c.created_at, c.updated_at, c.handoff_at,
           c.assignee_name, c.contact,
           (SELECT m.content FROM cs_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
           (SELECT m.role FROM cs_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_role
      FROM cs_conversations c
     WHERE coalesce(p_status, 'all') = 'all' OR c.status = p_status
     ORDER BY c.updated_at DESC
     LIMIT greatest(coalesce(p_limit, 50), 1) OFFSET greatest(coalesce(p_offset, 0), 0)
  ) x;
  RETURN jsonb_build_object('ok', true, 'total', v_total, 'items', v_items);
END $$;

-- 3.21 会话详情（管理端）
CREATE OR REPLACE FUNCTION cs_admin_messages(p_code text, p_conversation_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_conv jsonb; v_items jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  SELECT jsonb_build_object('id', c.id, 'status', c.status, 'intent', c.intent, 'satisfaction', c.satisfaction,
                            'feedback', c.feedback, 'contact', c.contact, 'created_at', c.created_at,
                            'user_label', c.user_label, 'summary', c.summary, 'summary_upto_id', c.summary_upto_id)
    INTO v_conv FROM cs_conversations c WHERE c.id = p_conversation_id;
  IF v_conv IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conversation not found');
  END IF;
  SELECT coalesce(jsonb_agg(x ORDER BY x.id), '[]'::jsonb) INTO v_items FROM (
    SELECT id, role, content, intent, meta, created_at FROM cs_messages
     WHERE conversation_id = p_conversation_id ORDER BY id
  ) x;
  RETURN jsonb_build_object('ok', true, 'conversation', v_conv, 'items', v_items);
END $$;

-- 3.22 管理端回复
CREATE OR REPLACE FUNCTION cs_admin_reply(p_code text, p_conversation_id bigint, p_content text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  IF coalesce(btrim(p_content), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty content');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cs_conversations WHERE id = p_conversation_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conversation not found');
  END IF;
  INSERT INTO cs_messages (conversation_id, role, content, meta)
  VALUES (p_conversation_id, 'agent', left(p_content, 4000), '{"kind":"agent"}'::jsonb)
  RETURNING id INTO v_id;
  UPDATE cs_conversations SET message_count = message_count + 1, updated_at = now() WHERE id = p_conversation_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- 3.23 管理端标记解决
CREATE OR REPLACE FUNCTION cs_admin_resolve(
  p_code text, p_conversation_id bigint, p_resolved boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  UPDATE cs_conversations
     SET status = CASE WHEN p_resolved THEN 'closed' ELSE 'handoff' END, updated_at = now()
   WHERE id = p_conversation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conversation not found');
  END IF;
  IF p_resolved THEN
    INSERT INTO cs_messages (conversation_id, role, content, meta)
    VALUES (p_conversation_id, 'system', '本会话已由人工客服处理完毕。', '{"kind":"resolved"}'::jsonb);
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- 3.24 FAQ 列表
CREATE OR REPLACE FUNCTION cs_admin_faq_list(p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  RETURN jsonb_build_object('ok', true, 'items', (
    SELECT coalesce(jsonb_agg(x ORDER BY x.priority DESC, x.id), '[]'::jsonb) FROM (
      SELECT id, question, answer, category, keywords, priority, enabled, created_at FROM cs_faqs
    ) x));
END $$;

-- 3.25 FAQ 新增 / 修改
CREATE OR REPLACE FUNCTION cs_admin_faq_save(
  p_code text, p_question text, p_answer text, p_id bigint DEFAULT NULL,
  p_category text DEFAULT 'general', p_keywords text DEFAULT '',
  p_priority int DEFAULT 0, p_enabled boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  IF coalesce(btrim(p_question), '') = '' OR coalesce(btrim(p_answer), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'question and answer required');
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO cs_faqs (question, answer, category, keywords, priority, enabled)
    VALUES (btrim(p_question), btrim(p_answer), coalesce(p_category, 'general'),
            coalesce(p_keywords, ''), coalesce(p_priority, 0), coalesce(p_enabled, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE cs_faqs
       SET question = btrim(p_question), answer = btrim(p_answer), category = coalesce(p_category, 'general'),
           keywords = coalesce(p_keywords, ''), priority = coalesce(p_priority, 0), enabled = coalesce(p_enabled, true)
     WHERE id = p_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'faq not found');
    END IF;
    v_id := p_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- 3.26 FAQ 删除
CREATE OR REPLACE FUNCTION cs_admin_faq_delete(p_code text, p_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  DELETE FROM cs_faqs WHERE id = p_id;
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- 3.27 知识缺口：FAQ 未命中的用户提问 Top30
CREATE OR REPLACE FUNCTION cs_admin_gaps(p_code text, p_days int DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  RETURN jsonb_build_object('ok', true, 'items', (
    SELECT coalesce(jsonb_agg(x ORDER BY x.cnt DESC, x.last_seen DESC), '[]'::jsonb) FROM (
      SELECT btrim(m.content) AS question,
             count(*) AS cnt,
             max(m.created_at) AS last_seen,
             max(m.intent) AS intent
        FROM cs_messages m
        JOIN cs_conversations c ON c.id = m.conversation_id
       WHERE m.role = 'user'
         AND coalesce(m.meta->>'faq_miss', 'false') = 'true'
         AND m.created_at > now() - make_interval(days => coalesce(p_days, 30))
         AND length(btrim(m.content)) >= 4
       GROUP BY btrim(m.content)
       ORDER BY count(*) DESC
       LIMIT 30
    ) x));
END $$;

-- 3.28 导出：逐条消息（前端拼 CSV）
CREATE OR REPLACE FUNCTION cs_admin_export(p_code text, p_status text DEFAULT 'all')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cs_settings WHERE key = 'admin_code' AND value = p_code) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  RETURN jsonb_build_object('ok', true, 'items', (
    SELECT coalesce(jsonb_agg(x ORDER BY x.conversation_id DESC, x.id), '[]'::jsonb) FROM (
      SELECT c.id AS conversation_id, coalesce(c.user_label, '访客') AS user_label,
             c.status, c.intent AS conv_intent, c.satisfaction, c.feedback, c.contact,
             m.id, m.role, m.content, m.intent, m.created_at
        FROM cs_conversations c
        JOIN cs_messages m ON m.conversation_id = c.id
       WHERE (coalesce(p_status, 'all') = 'all' OR c.status = p_status)
       ORDER BY c.id DESC, m.id
       LIMIT 5000
    ) x));
END $$;


-- ============================= 4. 种子数据 ==================================

-- 4.1 管理员口令：部署后请务必改成你自己的口令
--     注意用 DO NOTHING：重复执行本文件不会覆盖已有的真实口令
INSERT INTO cs_settings (key, value) VALUES ('admin_code', 'CHANGE-ME-BEFORE-DEPLOY')
  ON CONFLICT (key) DO NOTHING;

-- 4.2 坐席账号：口令同样是占位符，按需增删
INSERT INTO cs_agents (name, code) VALUES
  ('客服A', 'CHANGE-ME-1'),
  ('客服B', 'CHANGE-ME-2')
  ON CONFLICT (code) DO NOTHING;

-- 4.3 FAQ 知识库
INSERT INTO cs_faqs (question, answer, category, keywords, priority) VALUES
('退款政策是什么？', '支持 7 天无理由退款：商品未拆封、不影响二次销售的情况下，签收后 7 天内可全额退款。已拆封商品需经审核，若存在质量问题则不受 7 天限制。', 'refund', '退款,退钱,七天,无理由,退货,政策,退', 10),
('退款多久能到账？', '审核通过后 1-3 个工作日内原路退回。微信支付一般 T+1 到账，银行卡可能需 3-5 个工作日，具体以银行处理时间为准。', 'refund', '退款到账,多久,几天,原路返回,什么时候到', 9),
('如何申请退款？', '进入「我的订单」找到对应订单，点击「申请退款」，选择退款原因并提交。客服审核通过后自动发起退款，无需您再操作。', 'refund', '申请退款,怎么退,退款流程,退款申请,如何退款', 9),
('哪些情况不支持退款？', '以下情况不支持退款：定制类商品、已激活的数字商品、人为损坏的商品，以及超出 7 天且无质量问题的已拆封商品。', 'refund', '不能退,不支持退款,拆封,定制,激活', 7),
('怎么查询订单状态？', '进入「我的订单」即可看到全部订单及其状态（待付款 / 待发货 / 运输中 / 已签收）。已发货订单会显示快递公司与运单号，可直接追踪物流。', 'order', '查订单,订单状态,物流,发货,快递,运单号,到哪了', 10),
('下单后多久发货？', '现货商品在付款后 48 小时内出库，预售商品以商品页标注的发货时间为准。发货后您会收到短信通知。', 'order', '发货时间,多久发货,出库,什么时候发货', 8),
('可以修改收货地址吗？', '未发货订单可以修改：在订单详情页点击「修改地址」。已发货订单无法修改，建议联系快递员改派或申请拒收退回。', 'order', '改地址,收货地址,修改订单,地址错了', 8),
('订单可以取消吗？', '待付款订单可直接取消；待发货订单取消后会自动退款；运输中的订单需您先拒收，待包裹退回后系统自动退款。', 'order', '取消订单,不想要了,撤销订单', 7),
('账号无法登录怎么办？', '请先确认账号密码输入正确。若忘记密码，在登录页点击「忘记密码」通过手机号重置；若收不到验证码，请检查手机是否拦截了陌生短信，或稍后重试。', 'tech', '登录不了,登陆,密码,账号,验证码,登不上', 10),
('支付失败怎么处理？', '支付失败常见原因：余额不足、银行卡限额、网络超时。请先确认扣款是否成功（若已扣款请勿重复支付），然后更换支付方式重试，仍未解决请联系人工客服。', 'tech', '支付失败,付款失败,扣款,支付不了,付不了钱', 9),
('App 闪退或白屏怎么办？', '请先尝试：1) 完全退出 App 后重新打开；2) 检查是否为最新版本；3) 清理缓存。若仍异常，请提供手机型号与系统版本，我们会尽快排查。', 'tech', '闪退,白屏,卡顿,打不开,崩溃,黑屏', 9),
('如何联系人工客服？', '您可以在对话中直接输入「转人工」，系统会立即为您转接人工客服（工作时间 9:00-21:00）。也可以拨打客服电话 400-800-1234。', 'general', '人工,转人工,客服电话,真人,投诉', 10);

-- 4.4 演示订单（可删除，仅用于串联「查询订单」链路）
INSERT INTO cs_orders (order_no, item, amount, status, carrier, tracking_no, created_at, shipped_at, eta) VALUES
('A2024001', '轻氧空气净化器 Pro', 1299.00, '已签收', '顺丰速运', 'SF1234567890123', now() - interval '6 days', now() - interval '5 days', current_date - 2),
('B2024002', '智能恒温电水壶 1.5L', 329.00, '运输中', '中通快递', 'ZT7788990011223', now() - interval '3 days', now() - interval '2 days', current_date + 1),
('C2024003', '无线降噪耳机 Air 2', 899.00, '待发货', NULL, NULL, now() - interval '8 hours', NULL, current_date + 3)
  ON CONFLICT (order_no) DO NOTHING;
