/**
 * 面板全局样式表(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 约束沿用:本文件内容进 <style> 标签,不得出现反引号与 ${。
 */
export const PANEL_CSS = `
  :root{
    --bg:#060403; --window-bg:#0b0806; --glass:rgba(18,12,8,.5); --glass2:rgba(28,18,10,.55);
    --border:rgba(200,143,69,.28); --border-soft:rgba(200,143,69,.14);
    --text:#ece1d1; --muted:#97836a; --faint:#6b5c4a;
    --bronze:#c98f45; --bronze-dim:#8f6430; --bronze-glow:rgba(201,143,69,.45);
    --accent-bright:#f0d9ae; --accent-soft:rgba(201,143,69,.22);
    --grad-a:#d8a354; --grad-b:#a96f2b;
    --reply:#f2e7d4; --brand:#e9dcc6;
    --green:#9dc08b; --red:#e08a7a; --warn:#d9b36c;
    --serif:"Songti SC","STSong","Noto Serif SC","Source Han Serif SC","SimSun",serif;
    --sans:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;
    --sbw:264px;
    --bnav-h:44px; /* 底部导航条高度(导航从左栏搬到窗口底部;.page/#sidebar/canvas-shell 共用) */
 /* ---- 主题变量层扩展:语义化二级变量(每套主题必答;默认值=鎏金夜 dark 现状,视觉零漂移) ---- */
    --hover-bg:rgba(255,255,255,.05);            /* 悬停叠层(列表行/按钮) */
    --hover-bg2:rgba(255,255,255,.08);           /* 悬停叠层加重 */
    --on-accent:#1c1108;                          /* 主色底上的文字(seg 选中/渐变按钮) */
    --input-bg:rgba(0,0,0,.3);                    /* 输入类元件底 */
    --input-border:var(--border-soft);            /* 输入类元件边 */
    --code-bg:rgba(0,0,0,.35);                    /* 代码块/终端底 */
 /* ---- 消息流视觉分层令牌(内容类型→背景板;默认值=鎏金夜口径,
 * body 层按主题派生/覆写,七套主题零手写跟随。消费者=renderCodeBlock/codeLinesBlock/trGenericBody/trGrep) ---- */
    --surf-code:rgba(0,0,0,.34);                  /* 代码块板(源码/JSON 之外的通用代码面) */
    --surf-term:rgba(4,6,4,.52);                  /* 终端输出板(更沉,近真终端) */
    --surf-json:rgba(0,0,0,.26);                  /* JSON 结构板 */
    --surf-hit:rgba(201,143,69,.06);              /* 搜索命中/文件分组板 */
    --surf-card:rgba(0,0,0,.14);                  /* 工具/过程卡片底板(把卡片从正文里压下去) */
    --surf-fail:rgba(224,138,122,.07);            /* 失败面底色 */
    --sunken:rgba(0,0,0,.18);                     /* 下沉面板(思考卡/画布) */
    --chip-bg:rgba(0,0,0,.16);                    /* 徽章/who chip 底 */
    --overlay:rgba(0,0,0,.55);                    /* 模态遮罩 */
    --solid:#141009;                              /* 不透明面板(弹层/ghost) */
    --scrollbar:rgba(201,143,69,.32);             /* 滚动条拇指 */
    --focus-ring:rgba(201,143,69,.65);            /* :focus-visible 描边 */
    --accent2:#e08a7a;                            /* 第二强调色(glass 紫粉/ink 黑/新主题第二色) */
    --bubble-a:rgba(201,143,69,.14);              /* 用户气泡渐变起 */
    --bubble-b:rgba(201,143,69,.05);              /* 用户气泡渐变止 */
 /* ---- 语义着色色板(dark=鎏金夜基调,VS Code Dark+ 族色 adapted):
 * 变量在 body.light 与各 body.theme-* 块内同键覆盖;消费者=代码行块 .cl 内 span.tk-*
 * (数据源=journal tool.tokens 事件, SemanticTokenFile)。 ---- */
    --tok-func:#dcdcaa;            /* 函数/方法名 */
    --tok-type:#4ec9b0;            /* 类型名(class/struct/enum/interface/type 强调色) */
    --tok-var:#9cdcfe;             /* 变量/字段(无家族 dataType 或结构体/自定义类型) */
    --tok-num:#f0a868;             /* 数值家族(int/long/float/double… 暖橙) */
    --tok-str:#ce9178;             /* 字符家族(char*/string 暖红) */
    --tok-bool:#4fc1ff;            /* 布尔家族 */
    --tok-enum:#c3a6ff;            /* 枚举成员 */
    --tok-comment:#6e7f72;         /* 非代码调子(行号前缀 tk-lnno/指针点线) */
 /* ---- 动效变量层(一套定义,七套主题取值;默认=dark 鎏金夜;ink 全量压低+位移归零) ----
 * 红线:动画只用 transform/opacity/极小面积 box-shadow;大面积背景动画不做。
 * --anim-ease=出场快起缓收;--anim-ease-soft=柔进柔出(glass/浅色主题);--anim-ease-spring=回弹(done ✓)。 */
    --anim-dur-fast:130ms;         /* 微反馈(图标/工具卡/点按) */
    --anim-dur-base:190ms;         /* 入场(视图/消息/面板) */
    --anim-dur-slow:300ms;         /* 强调(回弹/大面板) */
    --anim-ease:cubic-bezier(.25,.7,.35,1);
    --anim-ease-soft:cubic-bezier(.3,.6,.3,1);
    --anim-ease-spring:cubic-bezier(.34,1.45,.5,1);
    --view-shift:6px;              /* 视图/面板入场位移量(ink=0) */
    --anim-decor:1;                /* 装饰性循环动画开关(ink=0 全关;参与 calc 幅度) */
 /* ---- 白板配色令牌层(--bcv-*;默认值=鎏金夜现状逐字相等 → 默认主题视觉零漂移) ----
 * 红线:画布外壳 canvas-shell.js 已占用 --cv-* 前缀(620 --cv-g / :627 --cv-s / :1533-1535 --cv-tray-*),
 * 白板令牌一律 --bcv-*,不得复写 --cv-*。
 * 消费者=白板 CSS 区(.bf-canvas/.bf-cv-*/.cv-*)与泳道色相内联 style(CV_LANE_HUES/CV_CODE_LANE_HUES/PG_HUES);
 * 六套主题只做本组令牌覆写(见 body.light / body.theme-* 的 bcv 覆写块),白板区不再出现第二份色值。 */
    --bcv-canvas-bg:rgba(12,9,6,.5);              /* 画布底 */
    --bcv-grid-dot:rgba(201,143,69,.13);          /* 画布点阵 */
    --bcv-float-bg:rgba(18,13,8,.92);             /* 画布浮层底(写者 chip 条/缩放条/添加面板/小地图) */
    --bcv-float-bg-dim:rgba(18,13,8,.62);         /* 小地图底(更透:不盖下层节点) */
    --bcv-float-bg-solid:rgba(18,13,8,.97);       /* 节点内评论浮层底 */
    --bcv-card-bg:var(--solid);                   /* 卡底 */
    --bcv-card-bd:var(--border);                  /* 卡边 */
    --bcv-card-head-bg:transparent;               /* 卡头条底 */
    --bcv-card-shadow:rgba(0,0,0,.45);            /* 卡投影 */
    --bcv-title-fg:var(--text);                   /* 卡标题字 */
    --bcv-sum-fg:var(--muted);                    /* 卡摘要字 */
    --bcv-foot-fg:var(--muted);                   /* 卡脚字 */
    --bcv-on-accent:#1c1108;                      /* 主色章上的深字(主线标签/泳道编号) */
    --bcv-lane-bg:var(--hover-bg);                /* 泳道框底 */
    --bcv-lane-bd:var(--border);                  /* 泳道框边 */
    --bcv-lane-orphan-bd:#6b5c4a;                 /* 「未连接」泳道 */
    --bcv-lane-orphan-bg:rgba(90,83,70,.05);
    --bcv-lane-h-fg:var(--text);                  /* 泳道标题字(内联 tag 色的兜底) */
    --bcv-lane-h-bg:rgba(8,12,18,.46);            /* code 板泳道标题条底 */
    --bcv-lane-no-fg:#0b1118;                     /* 泳道编号(彩色章上的深字) */
    --bcv-lane-seg-fg:var(--faint);               /* 分段序号 */
    --bcv-lane-seg-fg-strong:#9a9083;/* 分段序号强对比档(--faint #6b5c4a 压泳道底仅 2.46:1 → 5.08:1;暗底默认值) */
 /* 卡片文字清晰度:强对比档(浅底主题覆写为深一档同色系;默认=既有值 → 默认主题零漂移) */
    --bcv-lane-h-fg-strong:var(--bcv-lane-h-fg); /* 泳道标题强对比档(内联 tag 色的强档,见 CV_*_LANE_HUES) */
    --bcv-lane-1-fg-strong:var(--bcv-lane-1-fg); --bcv-lane-2-fg-strong:var(--bcv-lane-2-fg); --bcv-lane-3-fg-strong:var(--bcv-lane-3-fg);
    --bcv-lane-4-fg-strong:var(--bcv-lane-4-fg); --bcv-lane-5-fg-strong:var(--bcv-lane-5-fg); --bcv-lane-6-fg-strong:var(--bcv-lane-6-fg);
    --bcv-chip-info-fg:#c9bda6; --bcv-chip-role-fg:#e0c08f; --bcv-chip-ok-fg:#a9e6db; /* type-chip 字色(默认=原字面量) */
    --bcv-chip-warn-fg:#f6c9a0; --bcv-chip-bad-fg:#f7b6c0; --bcv-chip-branch-fg:#c3dcff;
    --bcv-chip-before-fg:#c9c0b2; --bcv-chip-target-fg:#a9c8ff; --bcv-chip-metric-fg:#f0e3c8;
    --bcv-lane-1:#c9a35e; --bcv-lane-2:#5b8ec9; --bcv-lane-3:#5a9a7a;
    --bcv-lane-4:#b06a8a; --bcv-lane-5:#8a6fc0; --bcv-lane-6:#5aa8b8;
    --bcv-lane-1-bg:rgba(201,163,94,.10); --bcv-lane-2-bg:rgba(91,142,201,.10); --bcv-lane-3-bg:rgba(90,154,122,.10);
    --bcv-lane-4-bg:rgba(176,106,138,.10); --bcv-lane-5-bg:rgba(138,111,192,.10); --bcv-lane-6-bg:rgba(80,170,190,.05);
    --bcv-lane-1-fg:#f0d39a; --bcv-lane-2-fg:#b8d4ff; --bcv-lane-3-fg:#b8e6cd;
    --bcv-lane-4-fg:#f0bfd0; --bcv-lane-5-fg:#d8c2f0; --bcv-lane-6-fg:#96d8e4;
    --bcv-pill-bg:rgba(18,42,29,.97);             /* start/end 药丸 */
    --bcv-pill-bd:#4fbf7a; --bcv-pill-fg:#e6f4e9; --bcv-pill-fg-dim:#9fb7a8;
    --bcv-pill-end-bg:rgba(43,33,17,.97); --bcv-pill-end-bd:#e0b46a;
    --bcv-diamond-bg:rgba(44,34,17,.97);          /* decision 菱形 */
    --bcv-diamond-bd:#d9b36c; --bcv-diamond-fg:#f0d39a; --bcv-diamond-fg-dim:#b8c7d8;
    --bcv-diamond-glow:rgba(217,179,108,.18);
    --bcv-code-bg:rgba(17,27,42,.96);             /* code 板卡底/边(基类) */
    --bcv-code-bd:#4d6f92; --bcv-code-fg:#cfe0ef; --bcv-code-sum-fg:#c7d4df;
    --bcv-code-kind-fg:#9fc6e8; --bcv-code-glyph:#d9b36c;
    --bcv-code-line-bd:rgba(111,168,255,.28); --bcv-code-line-first:rgba(217,179,108,.6);
    --bcv-code-tech-fg:#a9d6b0; --bcv-code-tech-bg:rgba(90,160,106,.14); --bcv-code-tech-bd:rgba(90,160,106,.25);
    --bcv-code-bg-module:rgba(19,34,54,.97); --bcv-code-bd-module:#5b8ec9;
    --bcv-code-bg-fn:rgba(17,29,47,.97); --bcv-code-bd-fn:#6fa8ff;
    --bcv-code-bg-tool:rgba(31,29,24,.97); --bcv-code-bd-tool:#8a7a5a;
    --bcv-code-bg-agent:rgba(16,38,40,.97); --bcv-code-bd-agent:#4f9a9a;
    --bcv-code-bg-io:rgba(18,34,24,.97); --bcv-code-bd-io:#6f9a6f;
    --bcv-code-bg-dec:rgba(44,34,17,.97); --bcv-code-bd-dec:#d9b36c;
    --bcv-code-bg-term:rgba(43,33,17,.97); --bcv-code-bd-term:#d9b36c;
    --bcv-code-edge-call:#82b8e8; --bcv-code-edge-data:#6fbf9f; --bcv-code-edge-verify:#d9b36c;
    --bcv-side-bg:rgba(11,18,28,.94);             /* code 板右侧栏 */
    --bcv-side-bd:rgba(120,160,200,.36); --bcv-side-bd-mid:rgba(120,160,200,.22); --bcv-side-bd-soft:rgba(120,160,200,.14);
    --bcv-side-fg:#c7d4df; --bcv-side-fg-2:#a9c9e8; --bcv-side-fg-3:#e6eef6;
    --bcv-side-fg-dim:#7f93a8; --bcv-side-fg-dim2:#8fb8d9; --bcv-side-p-fg:#aebdca;
    --bcv-legend-bg:var(--glass2);                /* 画布图例 */
    --bcv-legend-bd:var(--border-soft); --bcv-legend-fg:var(--muted); --bcv-legend-fg-dim:var(--faint);
    --bcv-edge-line:#8a7a5a;                      /* 普通/导航/虚拟边 */
    --bcv-edge-call:#c98f45; --bcv-edge-data:#5b8ec9; --bcv-edge-verify:#5aa06a;
    --bcv-edge-contains:#6f6350; --bcv-edge-back:#6b5c4a;
    --bcv-edge-main:#e0b46a; --bcv-accent:#e0b46a; --bcv-accent-2:#c9a25e;
    --bcv-flow-main:#4fbf7a;                      /* flow/code 板主线(实心绿,不闪动) */
    --bcv-edge-label:#d8c9a8; --bcv-edge-label-halo:rgba(16,12,6,.92); --bcv-edge-label-bg:rgba(10,8,6,.88);
 /* 画布左上「板型头/规则条」浮层(默认值=原写死值,零漂移) */
    --bcv-thead-bg:rgba(16,12,6,.93); --bcv-thead-bd:rgba(214,194,158,.24);
    --bcv-thead-fg:#d8c9a8; --bcv-thead-shadow:0 6px 18px rgba(0,0,0,.35);
    --bcv-edge-dot-bd:rgba(0,0,0,.55);
    --bcv-wire-page-bd:#c9a25e; --bcv-wire-page-bg:rgba(38,29,14,.96);
    --bcv-wire-page-head:rgba(201,162,94,.16); --bcv-wire-page-head-bd:rgba(201,162,94,.35);
    --bcv-wire-section-bd:#8a7a5a; --bcv-wire-section-bg:rgba(24,17,10,.8);
    --bcv-wire-component-bd:#5a5346; --bcv-wire-component-bg:rgba(24,17,10,.78);
    --bcv-wire-nav-bd:#6172f3; --bcv-wire-nav-bg:rgba(23,29,51,.9);
    --bcv-wire-title-fg:#eee2c6; --bcv-wire-sum-fg:#d8c9a8; --bcv-wire-foot-fg:#a89a7d;
    --bcv-wire-url-bg:rgba(0,0,0,.38);
    --bcv-wire-bg:rgba(14,9,5,.94);                /* 页面结构板 wire 卡底 */
    --bcv-pgmain-ring:rgba(224,180,106,.75); --bcv-pgmain-glow:rgba(224,180,106,.22);
    --bcv-dot-idle:#7a6a4e; --bcv-dot-ok:#9dc08b; --bcv-dot-warn:#d9b36c; --bcv-dot-bad:#e08a7a;
    --bcv-port-bd:#0b0806; --bcv-file-fg:#b9a887;
 /* 卡脚/徽标可读性:code flow 卡脚文件名(.cv-file-name/.cv-file-foot)+ 变更徽标(.bd-tag.cv-chg 四色);
 * 默认值=现状字面量逐字相等 → 默认主题视觉零漂移;浅底主题在本组里换深一档同色系(对比度 ≥4.5)。
 * 消费点:.cv-file-foot / .cv-file-name / .cv-file-sep / .cv-file-more / .bd-tag.add|modify|delete|keep */
    --bcv-file-name-fg:#bcd8f4; --bcv-file-name-bg:rgba(111,168,255,.10); --bcv-file-name-bd:rgba(111,168,255,.3);
    --bcv-file-foot-fg:#a8c6e2; --bcv-file-sep-fg:#6f88a6; --bcv-file-more-fg:#8fa8c2;
    --bcv-chg-add-fg:#9dc08b; --bcv-chg-add-bg:rgba(90,160,106,.18);
    --bcv-chg-modify-fg:#c98f45; --bcv-chg-modify-bg:rgba(201,143,69,.18);
    --bcv-chg-delete-fg:#e08a7a; --bcv-chg-delete-bg:rgba(224,138,122,.16);
    --bcv-chg-keep-fg:var(--muted); --bcv-chg-keep-bg:rgba(255,255,255,.06);
 /* docs/PPT 两层板(.cv-doc-*):结论根横幅/章容器卡/章内页卡;默认值=鎏金夜现状逐字相等 */
    --bcv-doc-root-bg1:rgba(64,44,18,.97); --bcv-doc-root-bg2:rgba(40,30,14,.97);
    --bcv-doc-root-bd:#e0b46a; --bcv-doc-root-tag-fg:#0b1118; --bcv-doc-root-tag-bg:#e0b46a;
    --bcv-doc-root-title:#f4e8cd; --bcv-doc-root-sum:#c9b78f;
    --bcv-doc-ch-h:#efe3c8; --bcv-doc-ch-hb-fg:#0b1118; --bcv-doc-ch-hb-bg:#d9b36c; --bcv-doc-ch-n:#9a8a6a; --bcv-doc-ch-sum:#bfae8b;
    --bcv-doc-page-bg:rgba(20,14,8,.96); --bcv-doc-page-bd:rgba(200,143,69,.4);
    --bcv-doc-pg-h:#e8dcc0; --bcv-doc-pg-hb:#d9b36c; --bcv-doc-pg-hb-bd:rgba(217,179,108,.45); --bcv-doc-pg-sum:#a8987a;
    --bcv-doc-shadow:rgba(0,0,0,.32); --bcv-doc-shadow-soft:rgba(0,0,0,.3);
 /* ---- 消息流排版令牌层(排版与主题解耦:body.light 与七套 body.theme-* 一律不得覆写本组令牌) ----
 * 目的:消息流 8 类内容(用户消息 / agent 正文 md / 思考卡 / 工具卡 / 代码·终端·JSON 板 /
 * 子代理过程卡 / 系统通知行 / chip 徽标)各自只允许一套字号·行高·字体·缩进·块距,
 * 同一类出现第二种取值即为缺陷。消费者=下方消息流各分区选择器;所有 font-size/line-height/
 * font-family/排版 margin 一律引用本组令牌,不留裸数值。 */
    --fs-body:19px;                /* 正文基准(=设置-外观字号「标准」;--reply-fs 在页面侧兜底覆盖) */
    --fs-body-sm:15px;             /* 次要叙述 / 系统通知行 / 表格 / 引用 */
    --fs-tool:12px;                /* 工具卡标题行 / 板头 / 卡内按钮与元信息 */
    --fs-code:12.5px;             /* 代码·终端·JSON 板(=设置-外观代码字号「中」;--code-fs 兜底覆盖) */
    --fs-code-sm:11.5px;           /* 行内 code / 路径 / 工具卡参数摘要 / 命中与 diff 行 */
    --fs-chip:11px;                /* chip / 徽标(固定档,不随正文字号缩放) */
    --lh-body:1.85;                /* 中文正文(衬线,行距放松; 1.8→1.85) */
    --lh-code:1.6;                 /* 代码/终端行距 */
    --lh-tight:1.6;                /* 表格 / 列表 / 从属卡(1.5→1.6:密排换成可读) */
    --indent-1:22px;               /* 正文→列表 / 引用(14→22:缩进不足则层级看不出) */
    --indent-2:44px;               /* 嵌套列表 */
    --indent-3:66px;               /* 三层列表 */
    --gap-msg:14px;                /* 不同消息块之间 */
    --gap-block:12px;              /* 块内段落 / 表格 / 引用 / 标题上下(8→12:信息密度过高主因) */
    --gap-head:22px;               /* md 标题上间距:标题与前文分离,形成视觉分组 */
    --gap-tool:6px;                /* 工具卡 / 板之间 */
    --font-body:var(--serif);      /* 中文衬线:用户消息与 agent 正文 */
    --font-ui:var(--sans);         /* 无衬线:标题 / 思考卡 / 系统行 / 子代理卡 */
    --font-mono:var(--mono);       /* 等宽:代码 / 终端 / 工具卡标题行 */
    --fs-h1:calc(var(--fs-body) * 1.3);   /* md 一级标题档(上限=正文×1.3) */
    --fs-h2:calc(var(--fs-body) * 1.15);  /* md 二级标题档 */
    --fs-h3:var(--fs-body);               /* md 三级标题档(=正文) */
 /* ---- J5 字距族:与 fs/lh/indent/gap/font 同层;body.light 与 body.theme-* 一律不得覆写 ---- */
    --ls-body:-.003em;   /* 中文正文 + 中英混排:略收,长段不散 */
    --ls-cjk:.01em;      /* 纯中文短标签/标题:微放 */
    --ls-tight:.02em;    /* 11~12px 小字可读性补偿 */
    --ls-code:0;         /* 等宽代码/路径/终端:恒 0,任何字距都会破列对齐 */
  }
 *{box-sizing:border-box;margin:0;padding:0}
  #tabbar{display:none !important} /* 用户明确不要会话标签条;即使 renderTabs 被恢复也硬隐藏 */
  html,body{height:100%}
  body{font-family:var(--sans);background:var(--bg);color:var(--text);overflow:hidden}
 /* 无边框桌面窗口:顶部 12px 画布留白=窗口拖拽带;右上角窗口控制做成画布卡片。
 浏览器/纯 Web 面板没有 preload,body.desktop-shell 不生效,零影响。 */
  #winDragBar,#winControls{display:none}
  body.desktop-shell #winDragBar{display:block;position:fixed;top:0;left:0;right:0;height:12px;z-index:10000;
    -webkit-app-region:drag;background:transparent}
  body.desktop-shell #winControls{display:flex;position:fixed;top:7px;right:10px;z-index:10001;height:28px;
    align-items:center;gap:1px;padding:0 3px;border:1px solid var(--border);border-radius:9px;
    background:var(--glass2);backdrop-filter:blur(12px);box-shadow:0 6px 18px rgba(0,0,0,.10);
    -webkit-app-region:drag}
  body.desktop-shell #winControls button{width:30px;height:22px;border:0;border-radius:6px;background:transparent;
    color:var(--muted);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;
    -webkit-app-region:no-drag}
  body.desktop-shell #winControls button:hover{background:var(--hover-bg2);color:var(--text)}
  body.desktop-shell #winControls button[data-win=close]:hover{background:rgba(184,84,63,.16);color:var(--red)}
  .wc-ico{position:relative;display:block;width:12px;height:12px}
  .wc-min::before{content:"";position:absolute;left:2px;right:2px;top:6.5px;height:1.5px;background:currentColor;border-radius:1px}
  .wc-max::before{content:"";position:absolute;inset:2px;border:1.5px solid currentColor;border-radius:2px}
  .wc-close::before,.wc-close::after{content:"";position:absolute;left:1px;right:1px;top:5.5px;height:1.5px;
    background:currentColor;border-radius:1px;transform:rotate(45deg)}
  .wc-close::after{transform:rotate(-45deg)}
  body.desktop-shell #winControls button[data-win=max].is-max .wc-max::before{inset:3px 1px 1px 3px}
  body.desktop-shell #winControls button[data-win=max].is-max .wc-max::after{content:"";position:absolute;
    right:1px;top:1px;width:7px;height:7px;border:1.5px solid currentColor;border-radius:2px}
  body::before{content:'';position:fixed;inset:0;pointer-events:none;
    background:radial-gradient(900px 600px at 85% 8%,rgba(201,143,69,.07),transparent 60%),
               radial-gradient(ellipse at 50% 50%,transparent 55%,rgba(0,0,0,.5) 100%)}

 /* 浅色主题(设置-外观,真实切换+持久化) */
  body.light{--bg:#f4eee3;--window-bg:#faf6ee;--glass:rgba(255,255,255,.55);--glass2:rgba(255,255,255,.68);
    --border:rgba(150,100,45,.35);--border-soft:rgba(150,100,45,.18);--text:#3d3223;--muted:#7c6c52;
    --faint:#a3937a;--reply:#43371f;--brand:#6b4a1d;--accent-bright:#7a5423;--accent-soft:rgba(150,100,45,.14);
    --green:#5c8a4a;--red:#b8543f;--warn:#a67c2e;
 /* 二级变量(浅色口径) */
    --hover-bg:rgba(120,90,50,.07);--hover-bg2:rgba(120,90,50,.12);--on-accent:#fff8ec;
    --input-bg:rgba(255,255,255,.72);--input-border:rgba(150,100,45,.28);--code-bg:#f1e9d9;--sunken:rgba(120,90,50,.08);
    --chip-bg:rgba(120,90,50,.12);--overlay:rgba(80,60,40,.35);--solid:#fffdf8;
    --scrollbar:rgba(150,100,45,.35);--focus-ring:rgba(150,100,45,.6);--accent2:#b8543f;
    --bubble-a:rgba(150,100,45,.16);--bubble-b:rgba(150,100,45,.06);
 /* 语义色板(暖纸浅色口径,VS Code Light+ 族色 adapted) */
    --tok-func:#795e26;--tok-type:#267f99;--tok-var:#0b4a8f;--tok-num:#7c4a03;
    --tok-str:#a31515;--tok-bool:#2456d9;--tok-enum:#7a3e9d;--tok-comment:#8b8272;
 /* 板色(暖纸浅色口径:浅底要更淡的板+更实的边,否则与纸面糊成一片) */
    --surf-code:rgba(150,100,45,.07);--surf-term:rgba(120,90,50,.10);--surf-json:rgba(150,100,45,.05);
    --surf-hit:rgba(150,100,45,.08);--surf-card:rgba(150,100,45,.04);--surf-fail:rgba(184,84,63,.07);
 /* 动效变量(柔和过渡:稍缓,无装饰循环) */
    --anim-dur-fast:140ms;--anim-dur-base:200ms;--anim-dur-slow:300ms;--anim-decor:0}
  body.light::before{background:radial-gradient(900px 600px at 85% 8%,rgba(150,100,45,.06),transparent 60%),
    radial-gradient(ellipse at 50% 50%,transparent 60%,rgba(120,90,50,.12) 100%)}
  body.light #sidebar,body.light .sb-acts{background:rgba(250,246,238,.9)}
  body.light .cc-box{background:#fffdf8;color:var(--text)}
 /* 白板配色:暖纸浅色(light) —— 白板 CSS 区只吃 --bcv-*,此处集中覆写(派生自本主题 --window-bg/--text/--muted/--border) */
  body.light{
    --bcv-canvas-bg:rgba(255,252,246,.72);--bcv-grid-dot:rgba(150,100,45,.20);--bcv-float-bg:rgba(255,253,248,.96);--bcv-float-bg-dim:rgba(255,253,248,.90);--bcv-float-bg-solid:rgba(255,253,248,.98);--bcv-card-bg:#fffdf8;
    --bcv-card-bd:rgba(90,70,40,.28);--bcv-card-head-bg:rgba(201,162,94,.14);--bcv-card-shadow:rgba(120,90,50,.16);--bcv-title-fg:#2a2118;--bcv-sum-fg:#6b5c4a;--bcv-foot-fg:#6b5c4a;
    --bcv-on-accent:#fff8ec;--bcv-lane-bg:rgba(150,100,45,.05);--bcv-lane-bd:rgba(150,100,45,.28);--bcv-lane-orphan-bd:#a89372;--bcv-lane-orphan-bg:rgba(150,100,45,.05);--bcv-lane-h-fg:#5c4b2e;
    --bcv-lane-h-bg:rgba(255,252,246,.86);--bcv-lane-no-fg:#fff8ec;--bcv-lane-seg-fg:#8a7a5a;--bcv-lane-1:#a8763a;--bcv-lane-2:#3f6fa8;--bcv-lane-3:#3f7a5a;
 /* 文字清晰度:强对比档(同色系加深/提亮,消除浅底上的淡彩小字) */
    --bcv-lane-h-fg-strong:#3A2E1C;--bcv-lane-seg-fg:#6B5A3A;--bcv-lane-seg-fg-strong:#6B5A3A;
    --bcv-lane-1-fg-strong:#6E4A12;--bcv-lane-2-fg-strong:#1F4C7A;--bcv-lane-3-fg-strong:#1E5C3E;
    --bcv-lane-4-fg-strong:#6E2440;--bcv-lane-5-fg-strong:#4A2F7A;--bcv-lane-6-fg-strong:#0F5460;
    --bcv-chip-info-fg:#544C3E;--bcv-chip-role-fg:#7A4E0E;--bcv-chip-ok-fg:#0F5C52;--bcv-chip-warn-fg:#8A4A12;
    --bcv-chip-bad-fg:#8E1F2E;--bcv-chip-branch-fg:#26538F;--bcv-chip-before-fg:#57503F;--bcv-chip-target-fg:#1F4272;--bcv-chip-metric-fg:#6E4B0D;
    --bcv-lane-4:#9c4f74;--bcv-lane-5:#6b52a0;--bcv-lane-6:#2f8090;--bcv-lane-1-bg:rgba(168,118,58,.10);--bcv-lane-2-bg:rgba(63,111,168,.10);--bcv-lane-3-bg:rgba(63,122,90,.10);
    --bcv-lane-4-bg:rgba(156,79,116,.10);--bcv-lane-5-bg:rgba(107,82,160,.10);--bcv-lane-6-bg:rgba(47,128,144,.08);--bcv-lane-1-fg:#7c5a22;--bcv-lane-2-fg:#2f5a8c;--bcv-lane-3-fg:#2f6a4a;
    --bcv-lane-4-fg:#8c4462;--bcv-lane-5-fg:#5c458c;--bcv-lane-6-fg:#24667a;--bcv-pill-bg:#eaf4ec;--bcv-pill-bd:#3f8a5e;--bcv-pill-fg:#1f3a28;
    --bcv-pill-fg-dim:#4f6a58;--bcv-pill-end-bg:#fdf3de;--bcv-pill-end-bd:#b8842e;--bcv-diamond-bg:#fff8e8;--bcv-diamond-bd:#b8842e;--bcv-diamond-fg:#6b4a12;
    --bcv-diamond-fg-dim:#6b5c4a;--bcv-diamond-glow:rgba(184,132,46,.18);--bcv-code-bg:#fdfbf5;--bcv-code-bd:#a99b80;--bcv-code-fg:#3d3223;--bcv-code-sum-fg:#5c4b2e;
    --bcv-code-kind-fg:#4a3a22;--bcv-code-glyph:#a8763a;--bcv-code-line-bd:rgba(90,120,170,.28);--bcv-code-line-first:rgba(168,118,58,.60);--bcv-code-tech-fg:#2f6a4a;--bcv-code-tech-bg:rgba(63,122,90,.10);
    --bcv-code-tech-bd:rgba(63,122,90,.25);--bcv-code-bg-module:#eef3fb;--bcv-code-bd-module:#4f78a8;--bcv-code-bg-fn:#eff4fd;--bcv-code-bd-fn:#3f6fa8;--bcv-code-bg-tool:#f4f1ea;
    --bcv-code-bd-tool:#8a7a5a;--bcv-code-bg-agent:#eaf5f5;--bcv-code-bd-agent:#3f8282;--bcv-code-bg-io:#ecf4ee;--bcv-code-bd-io:#4f7a4f;--bcv-code-bg-dec:#fdf3de;--bcv-thead-bg:rgba(255,253,248,.95);--bcv-thead-bd:rgba(150,100,45,.28);--bcv-thead-fg:#3a2f22;--bcv-thead-shadow:0 6px 18px rgba(90,70,40,.14);
    --bcv-code-bd-dec:#b8842e;--bcv-code-bg-term:#fdf3de;--bcv-code-bd-term:#b8842e;--bcv-code-edge-call:#3f6fa8;--bcv-code-edge-data:#3f8a6a;--bcv-code-edge-verify:#a8763a;
    --bcv-side-bg:rgba(255,253,248,.96);--bcv-side-bd:rgba(90,120,170,.36);--bcv-side-bd-mid:rgba(90,120,170,.22);--bcv-side-bd-soft:rgba(90,120,170,.14);--bcv-side-fg:#3d3223;--bcv-side-fg-2:#2f5a8c;
    --bcv-side-fg-3:#241a08;--bcv-side-fg-dim:#6b5c4a;--bcv-side-fg-dim2:#3f6fa8;--bcv-side-p-fg:#4a4030;--bcv-legend-bg:rgba(255,253,248,.92);--bcv-legend-bd:rgba(150,100,45,.20);
    --bcv-legend-fg:#5c4b2e;--bcv-legend-fg-dim:#8a7a5a;--bcv-edge-line:#8a7a5a;--bcv-edge-call:#a8763a;--bcv-edge-data:#3f6fa8;--bcv-edge-verify:#3f7a5a;
    --bcv-edge-contains:#a89a7d;--bcv-edge-back:#a89a7d;--bcv-edge-main:#b8842e;--bcv-accent:#b8842e;--bcv-accent-2:#a8763a;--bcv-edge-label:#5c4b2e;
    --bcv-edge-label-halo:rgba(255,252,246,.92);--bcv-edge-label-bg:rgba(255,252,246,.92);--bcv-edge-dot-bd:rgba(90,70,40,.50);--bcv-wire-page-bd:#c9a25e;--bcv-wire-page-bg:#fffdf8;--bcv-wire-page-head:rgba(201,162,94,.14);
    --bcv-wire-page-head-bd:rgba(201,162,94,.40);--bcv-wire-section-bd:#a89372;--bcv-wire-section-bg:#fbf7ef;--bcv-wire-component-bd:#a99b80;--bcv-wire-component-bg:#fdfbf5;--bcv-wire-nav-bd:#6172f3;
    --bcv-wire-nav-bg:#f2f3fd;--bcv-wire-title-fg:#2a2118;--bcv-wire-sum-fg:#6b5c4a;--bcv-wire-foot-fg:#6b5c4a;--bcv-wire-url-bg:rgba(120,90,50,.08);--bcv-wire-bg:#fffdf8;--bcv-flow-main:#3f8a5e;--bcv-pgmain-ring:rgba(201,162,94,.75);
    --bcv-pgmain-glow:rgba(201,162,94,.20);--bcv-dot-idle:#a3937a;--bcv-dot-ok:#7a9a6a;--bcv-dot-warn:#c9a25e;--bcv-dot-bad:#b8543f;--bcv-port-bd:#fffdf8;
    --bcv-file-fg:#7a6a52;--bcv-page-1-bg:#f6f4f1;--bcv-page-2-bg:#eef3ee;--bcv-page-3-bg:#eef1f7;--bcv-page-4-bg:#f5eef4;--bcv-page-5-bg:#f7f0ec;
    --bcv-doc-root-bg1:rgba(255,253,248,.97);--bcv-doc-root-bg2:rgba(250,244,234,.97);--bcv-doc-root-bd:rgba(150,100,45,.5);--bcv-doc-root-tag-fg:#fffdf8;--bcv-doc-root-tag-bg:#7a5423;
    --bcv-doc-root-title:#2a2118;--bcv-doc-root-sum:#6b5c4a;--bcv-doc-ch-h:#2a2118;--bcv-doc-ch-hb-fg:#fffdf8;--bcv-doc-ch-hb-bg:#7a5423;--bcv-doc-ch-n:#6B5A3A;--bcv-doc-ch-sum:#6b5c4a;
    --bcv-doc-page-bg:rgba(255,253,248,.96);--bcv-doc-page-bd:rgba(150,100,45,.35);--bcv-doc-pg-h:#2a2118;--bcv-doc-pg-hb:#7a5423;--bcv-doc-pg-hb-bd:rgba(150,100,45,.35);--bcv-doc-pg-sum:#6b5c4a;
    --bcv-doc-shadow:rgba(120,90,50,.16);--bcv-doc-shadow-soft:rgba(120,90,50,.12);
 /* 卡脚文件名/变更徽标:浅底换深一档同色系(经验证 >=5.0:1) */
    --bcv-file-name-fg:#1F4C7A;--bcv-file-name-bg:rgba(63,111,168,.12);--bcv-file-name-bd:rgba(63,111,168,.45);
    --bcv-file-foot-fg:#3A5C7A;--bcv-file-sep-fg:#56677F;--bcv-file-more-fg:#46596E;
    --bcv-chg-add-fg:#1E5C3E;--bcv-chg-add-bg:rgba(63,122,90,.16);--bcv-chg-modify-fg:#7A4E0E;--bcv-chg-modify-bg:rgba(168,118,58,.20);
    --bcv-chg-delete-fg:#8E1F2E;--bcv-chg-delete-bg:rgba(184,84,63,.14);--bcv-chg-keep-fg:#5C4B2E;--bcv-chg-keep-bg:rgba(122,84,35,.12)}


 /* ===== 多主题体系(追加式;每套=完整 CSS 变量集+特征装饰层;类切换 body.theme-<key>,localStorage zh:theme) =====
 * 义务:按钮四态/输入/下拉/模态/卡片/滚动条/选区/chip 全覆盖——变量层保证「一套变量=全站成立」。 */

 /* --- 主题公共件:统一按钮基座(裸 button 兜底,类规则特异性更高不受影响)+ 四态 + 键盘可达 --- */
  button{background:var(--hover-bg);border:1px solid var(--border-soft);color:var(--muted);
         border-radius:8px;font-size:11px;padding:4px 12px;
         transition:border-color var(--anim-dur-fast) var(--anim-ease),color var(--anim-dur-fast) var(--anim-ease),background var(--anim-dur-fast) var(--anim-ease),box-shadow var(--anim-dur-fast) var(--anim-ease),transform 60ms var(--anim-ease)}
  button:hover{border-color:var(--bronze);color:var(--text)}
  button:active{transform:translateY(1px)}
  button:disabled{opacity:.45;cursor:not-allowed;transform:none}
  :where(button,input,select,textarea,[tabindex]):focus{outline:none}
  :where(button,input,select,textarea,[tabindex]):focus-visible{outline:2px solid var(--focus-ring);outline-offset:1px}
 /* 输入类元件基座(裸 input/textarea 兜底;checkbox/radio/range/file 走 accent-color) */
  input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),textarea{
    font-family:var(--sans);color:var(--text);background:var(--input-bg);border:1px solid var(--input-border);
    border-radius:8px;padding:4px 10px;font-size:12px}
  input::placeholder,textarea::placeholder{color:var(--faint)}
  input:focus,textarea:focus{border-color:var(--bronze)}
  input[type=checkbox],input[type=radio]{accent-color:var(--bronze);vertical-align:-2px}
  input[type=range]{accent-color:var(--bronze);background:transparent;border:none;padding:0}
  ::selection{background:var(--accent-soft);color:var(--accent-bright)}
  ::-webkit-scrollbar-thumb{background:var(--scrollbar)}
 /* 镜像下拉组件(原生 select 保留为数据源,视觉隐藏) */
  .ui-sel-wrap{position:relative;display:inline-flex;max-width:100%}
  select.ui-native{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;
    pointer-events:none!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;margin:0!important;padding:0!important;border:0!important}
  .ui-sel{display:inline-flex;align-items:center;gap:6px;background:var(--input-bg);border:1px solid var(--input-border);
    border-radius:8px;color:var(--text);font-size:11px;padding:4px 8px;min-width:72px;max-width:100%;text-align:left}
  .ui-sel:hover{border-color:var(--bronze);color:var(--text)}
  .ui-sel[aria-expanded="true"]{border-color:var(--bronze);box-shadow:0 0 0 1px var(--accent-soft)}
  .ui-sel .ui-sel-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
  .ui-sel .ui-sel-chev{color:var(--faint);font-size:9px;flex-shrink:0;transition:transform .12s;display:flex;align-items:center}
  .ui-sel .ui-sel-chev .icn{width:10px;height:10px;stroke-width:2}
  .ui-sel[aria-expanded="true"] .ui-sel-chev{transform:rotate(180deg)}
  .ui-sel-pop{position:absolute;top:calc(100% + 4px);left:0;min-width:100%;max-height:240px;overflow-y:auto;z-index:95;
    background:var(--solid);border:1px solid var(--border);border-radius:9px;box-shadow:0 12px 40px var(--overlay);
    display:none;padding:4px}
  .ui-sel-pop.up{top:auto;bottom:calc(100% + 4px)}
  .ui-sel-pop.open{display:block}
  .ui-sel-opt{padding:4px 10px;border-radius:6px;font-size:11px;color:var(--muted);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ui-sel-opt:hover{background:var(--hover-bg);color:var(--text)}
  .ui-sel-opt.hot{background:var(--accent-soft);color:var(--accent-bright)}
  .ui-sel-opt[aria-selected="true"]{color:var(--bronze)}
  .ui-sel-opt.none{color:var(--faint);font-style:italic}
 /* 主题化模态(uiAlert/uiConfirm/uiPrompt 共用壳) */
  .uid-mask{position:fixed;inset:0;z-index:130;background:var(--overlay);display:flex;align-items:center;justify-content:center;
    animation:uidIn .16s ease}
  @keyframes uidIn{from{opacity:0}to{opacity:1}}
  .uid-box{width:min(480px,calc(100vw - 48px));background:var(--solid);border:1px solid var(--border);border-radius:14px;
    padding:18px 20px;box-shadow:0 24px 80px var(--overlay),0 0 0 1px var(--accent-soft);animation:uidPop .16s ease}
  @keyframes uidPop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
  .uid-box .uid-kicker{font-size:9px;letter-spacing:3px;text-transform:uppercase;color:var(--faint);margin-bottom:6px;
    display:flex;align-items:center;gap:6px}
  .uid-box .uid-kicker::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--uid-tone,var(--bronze));
    box-shadow:0 0 8px var(--uid-tone,var(--bronze-glow))}
  .uid-box h3{font-size:13.5px;font-weight:400;color:var(--brand);letter-spacing:1px;margin-bottom:10px}
  .uid-box .uid-msg{font-size:12px;line-height:1.8;color:var(--text);white-space:pre-wrap;word-break:break-word;
    max-height:46vh;overflow-y:auto;background:var(--sunken);border-radius:9px;padding:10px 12px;margin-bottom:14px}
  .uid-box .uid-input{width:100%;font-size:12.5px;padding:7px 12px;margin-bottom:14px}
  .uid-btns{display:flex;gap:10px;justify-content:flex-end}
  .uid-btns button{min-width:88px;padding:7px 0;font-size:12px;letter-spacing:2px;border-radius:9px}
  .uid-btns .uid-ok{border-color:var(--bronze);color:var(--on-accent);
    background:linear-gradient(135deg,var(--grad-a),var(--grad-b))}
  .uid-btns .uid-ok:hover{box-shadow:0 0 14px var(--bronze-glow);color:var(--on-accent)}
  .uid-btns .uid-cancel{background:transparent;color:var(--muted)}
  .uid-btns .uid-cancel:hover{border-color:var(--red);color:var(--red)}
 /* 运行中项目移除确认(ref WorkspaceSidebarItem.tsx:349-368 confirmVariant:"destructive"):危险色确认钮 */
  .uid-btns .uid-ok.danger{border-color:var(--red);background:linear-gradient(135deg,var(--red),var(--red));color:#fff}
  .uid-btns .uid-ok.danger:hover{box-shadow:0 0 14px rgba(224,138,122,.45);color:#fff}
  .uid-box.danger{--uid-tone:var(--red)}
  .uid-box.warning{--uid-tone:var(--warn)}
  .uid-box.info{--uid-tone:var(--bronze)}

 /* --- 主题一:砂陶松影(sand)暖砂底/陶土主色/松林深绿——浅色、无辉光 --- */
  body.theme-sand{--bg:#E3DCD2;--window-bg:#EDE7DE;--glass:rgba(255,252,247,.55);--glass2:rgba(255,252,247,.72);
    --border:rgba(1,51,40,.28);--border-soft:rgba(1,51,40,.13);
    --text:#013328;--muted:#4E655A;--faint:#87948B;
    --bronze:#CC8B65;--bronze-dim:#A96B49;--bronze-glow:rgba(204,139,101,.38);
    --accent-bright:#9A4F30;--accent-soft:rgba(204,139,101,.16);--accent2:#013328;
    --grad-a:#CC8B65;--grad-b:#A96B49;
    --reply:#0B3A2E;--brand:#013328;
    --green:#3F6B4F;--red:#A84A3C;--warn:#9A6A2F;
    --hover-bg:rgba(1,51,40,.06);--hover-bg2:rgba(1,51,40,.10);--on-accent:#FFF8F1;
    --input-bg:rgba(255,252,247,.76);--input-border:rgba(1,51,40,.20);--code-bg:#DCD4C6;--sunken:rgba(1,51,40,.06);
    --chip-bg:rgba(1,51,40,.08);--overlay:rgba(16,12,13,.35);--solid:#F6F1E9;
    --scrollbar:rgba(1,51,40,.28);--focus-ring:rgba(204,139,101,.68);
    --bubble-a:rgba(204,139,101,.18);--bubble-b:rgba(204,139,101,.06);
 /* 语义色板(sand:松绿/陶土暖色族,冷底暖字) */
    --tok-func:#8A4B2B;--tok-type:#013328;--tok-var:#1E5A4A;--tok-num:#9C5A2A;
    --tok-str:#8E3B3B;--tok-bool:#2F6B57;--tok-enum:#6D4C41;--tok-comment:#87948B;
 /* 板色(sand:暖砂薄板,靠明度差分层) */
    --surf-code:rgba(1,51,40,.06);--surf-term:rgba(1,51,40,.10);--surf-json:rgba(1,51,40,.04);
    --surf-hit:rgba(204,139,101,.10);--surf-card:rgba(1,51,40,.03);--surf-fail:rgba(168,74,60,.07);
 /* 动效变量(sand:浅色柔和,无装饰循环) */
    --anim-dur-fast:140ms;--anim-dur-base:200ms;--anim-dur-slow:300ms;--view-shift:4px;--anim-decor:0}
  body.theme-sand::before{background:
    radial-gradient(900px 600px at 85% 8%,rgba(204,139,101,.10),transparent 60%),
    radial-gradient(700px 500px at 10% 90%,rgba(1,51,40,.06),transparent 60%),
    radial-gradient(ellipse at 50% 50%,transparent 60%,rgba(16,12,13,.10) 100%)}
  body.theme-sand #sidebar,body.theme-sand .sb-acts{background:rgba(237,231,222,.9)}
  body.theme-sand .cc-box{background:#F8F3EC;color:var(--text)}
 /* 白板配色:沙丘(sand) —— 白板 CSS 区只吃 --bcv-*,此处集中覆写(派生自本主题 --window-bg/--text/--muted/--border) */
  body.theme-sand{
    --bcv-canvas-bg:rgba(237,231,222,.72);--bcv-grid-dot:rgba(1,51,40,.18);--bcv-float-bg:rgba(246,241,233,.96);--bcv-float-bg-dim:rgba(246,241,233,.90);--bcv-float-bg-solid:rgba(246,241,233,.98);--bcv-card-bg:#F6F1E9;
    --bcv-card-bd:rgba(1,51,40,.28);--bcv-card-head-bg:rgba(204,139,101,.16);--bcv-card-shadow:rgba(16,12,13,.14);--bcv-title-fg:#013328;--bcv-sum-fg:#4E655A;--bcv-foot-fg:#4E655A;
    --bcv-on-accent:#FFF8F1;--bcv-lane-bg:rgba(1,51,40,.05);--bcv-lane-bd:rgba(1,51,40,.22);--bcv-lane-orphan-bd:#7E8C80;--bcv-lane-orphan-bg:rgba(1,51,40,.05);--bcv-lane-h-fg:#013328;
    --bcv-lane-h-bg:rgba(246,241,233,.86);--bcv-lane-no-fg:#FFF8F1;--bcv-lane-seg-fg:#87948B;--bcv-lane-1:#CC8B65;--bcv-lane-2:#4A7A8C;--bcv-lane-3:#3F6B4F;
 /* 文字清晰度:强对比档(同色系加深/提亮,消除浅底上的淡彩小字) */
    --bcv-lane-h-fg-strong:#3A2E1C;--bcv-lane-seg-fg:#4F5A54;--bcv-lane-seg-fg-strong:#4F5A54;
    --bcv-lane-1-fg-strong:#6E4A12;--bcv-lane-2-fg-strong:#1F4C7A;--bcv-lane-3-fg-strong:#1E5C3E;
    --bcv-lane-4-fg-strong:#6E2440;--bcv-lane-5-fg-strong:#4A2F7A;--bcv-lane-6-fg-strong:#0F5460;
    --bcv-chip-info-fg:#544C3E;--bcv-chip-role-fg:#7A4E0E;--bcv-chip-ok-fg:#0F5C52;--bcv-chip-warn-fg:#8A4A12;
    --bcv-chip-bad-fg:#8E1F2E;--bcv-chip-branch-fg:#26538F;--bcv-chip-before-fg:#57503F;--bcv-chip-target-fg:#1F4272;--bcv-chip-metric-fg:#6E4B0D;
    --bcv-lane-4:#9A5F6E;--bcv-lane-5:#6F5A8C;--bcv-lane-6:#3F7A82;--bcv-lane-1-bg:rgba(204,139,101,.12);--bcv-lane-2-bg:rgba(74,122,140,.10);--bcv-lane-3-bg:rgba(63,107,79,.10);
    --bcv-lane-4-bg:rgba(154,95,110,.10);--bcv-lane-5-bg:rgba(111,90,140,.10);--bcv-lane-6-bg:rgba(63,122,130,.08);--bcv-lane-1-fg:#7A4A2A;--bcv-lane-2-fg:#24505E;--bcv-lane-3-fg:#24432F;
    --bcv-lane-4-fg:#6B3546;--bcv-lane-5-fg:#453658;--bcv-lane-6-fg:#235058;--bcv-pill-bg:#E9F2EA;--bcv-pill-bd:#3F6B4F;--bcv-pill-fg:#01211A;
    --bcv-pill-fg-dim:#4E655A;--bcv-pill-end-bg:#F8F0E4;--bcv-pill-end-bd:#A96B49;--bcv-diamond-bg:#F8F0E4;--bcv-diamond-bd:#A96B49;--bcv-diamond-fg:#6B4223;
    --bcv-diamond-fg-dim:#4E655A;--bcv-diamond-glow:rgba(169,107,73,.18);--bcv-code-bg:#F1F5F4;--bcv-code-bd:#7A8F86;--bcv-code-fg:#16352C;--bcv-code-sum-fg:#2B4A40;
    --bcv-code-kind-fg:#24616F;--bcv-code-glyph:#A96B49;--bcv-code-line-bd:rgba(58,98,114,.26);--bcv-code-line-first:rgba(169,107,73,.60);--bcv-code-tech-fg:#2F5540;--bcv-code-tech-bg:rgba(63,107,79,.10);
    --bcv-code-tech-bd:rgba(63,107,79,.25);--bcv-code-bg-module:#EDF3F4;--bcv-code-bd-module:#3A6272;--bcv-code-bg-fn:#EDF1F6;--bcv-code-bd-fn:#2F5C86;--bcv-code-bg-tool:#F5F2EC;
    --bcv-code-bd-tool:#8B8472;--bcv-code-bg-agent:#EAF3F2;--bcv-code-bd-agent:#2C6E75;--bcv-code-bg-io:#ECF4EE;--bcv-code-bd-io:#3F6B4F;--bcv-code-bg-dec:#F8F0E4;--bcv-thead-bg:rgba(248,243,236,.95);--bcv-thead-bd:rgba(1,51,40,.26);--bcv-thead-fg:#013328;--bcv-thead-shadow:0 6px 18px rgba(1,51,40,.14);
    --bcv-code-bd-dec:#A96B49;--bcv-code-bg-term:#F8F0E4;--bcv-code-bd-term:#A96B49;--bcv-code-edge-call:#3A6272;--bcv-code-edge-data:#3F6B4F;--bcv-code-edge-verify:#A96B49;
    --bcv-side-bg:#F6F1E9;--bcv-side-bd:rgba(1,51,40,.26);--bcv-side-bd-mid:rgba(1,51,40,.18);--bcv-side-bd-soft:rgba(1,51,40,.12);--bcv-side-fg:#013328;--bcv-side-fg-2:#2C5060;
    --bcv-side-fg-3:#01211A;--bcv-side-fg-dim:#4E655A;--bcv-side-fg-dim2:#2C5060;--bcv-side-p-fg:#245043;--bcv-legend-bg:rgba(246,241,233,.92);--bcv-legend-bd:rgba(1,51,40,.20);
    --bcv-legend-fg:#013328;--bcv-legend-fg-dim:#4E655A;--bcv-edge-line:#8B8472;--bcv-edge-call:#A96B49;--bcv-edge-data:#3A6272;--bcv-edge-verify:#3F6B4F;
    --bcv-edge-contains:#8B8472;--bcv-edge-back:#8B8472;--bcv-edge-main:#9A5F3D;--bcv-accent:#9A5F3D;--bcv-accent-2:#A96B49;--bcv-edge-label:#013328;
    --bcv-edge-label-halo:rgba(246,241,233,.92);--bcv-edge-label-bg:rgba(246,241,233,.92);--bcv-edge-dot-bd:rgba(255,255,255,.55);--bcv-wire-page-bd:#CC8B65;--bcv-wire-page-bg:#F8F3EC;--bcv-wire-page-head:rgba(204,139,101,.16);
    --bcv-wire-page-head-bd:rgba(204,139,101,.40);--bcv-wire-section-bd:#7E8C80;--bcv-wire-section-bg:#F1ECE4;--bcv-wire-component-bd:#8B948B;--bcv-wire-component-bg:#F4F1E9;--bcv-wire-nav-bd:#3F6B4F;
    --bcv-wire-nav-bg:#EDF2ED;--bcv-wire-title-fg:#013328;--bcv-wire-sum-fg:#4E655A;--bcv-wire-foot-fg:#4E655A;--bcv-wire-url-bg:rgba(1,51,40,.06);--bcv-wire-bg:#F4F0E8;--bcv-flow-main:#3F6B4F;--bcv-pgmain-ring:rgba(204,139,101,.75);
    --bcv-pgmain-glow:rgba(204,139,101,.20);--bcv-dot-idle:#87948B;--bcv-dot-ok:#3F6B4F;--bcv-dot-warn:#9A6A2F;--bcv-dot-bad:#A84A3C;--bcv-port-bd:#F6F1E9;
    --bcv-file-fg:#4E655A;--bcv-page-1-bg:#F2F4F3;--bcv-page-2-bg:#EFF4EF;--bcv-page-3-bg:#EDF2F6;--bcv-page-4-bg:#F5F0F2;--bcv-page-5-bg:#F6F1EA;
    --bcv-doc-root-bg1:rgba(250,248,244,.97);--bcv-doc-root-bg2:rgba(240,238,233,.97);--bcv-doc-root-bd:rgba(1,51,40,.30);--bcv-doc-root-tag-fg:#F6F1E9;--bcv-doc-root-tag-bg:#013328;
    --bcv-doc-root-title:#013328;--bcv-doc-root-sum:#4E655A;--bcv-doc-ch-h:#013328;--bcv-doc-ch-hb-fg:#F6F1E9;--bcv-doc-ch-hb-bg:#013328;--bcv-doc-ch-n:#4A5A50;--bcv-doc-ch-sum:#4E655A;
    --bcv-doc-page-bg:rgba(246,241,233,.96);--bcv-doc-page-bd:rgba(1,51,40,.22);--bcv-doc-pg-h:#013328;--bcv-doc-pg-hb:#4E655A;--bcv-doc-pg-hb-bd:rgba(1,51,40,.28);--bcv-doc-pg-sum:#4E655A;
    --bcv-doc-shadow:rgba(10,30,22,.12);--bcv-doc-shadow-soft:rgba(10,30,22,.10);
    --bcv-file-name-fg:#1B4A73;--bcv-file-name-bg:rgba(58,98,114,.12);--bcv-file-name-bd:rgba(58,98,114,.45);
    --bcv-file-foot-fg:#33566F;--bcv-file-sep-fg:#4E6273;--bcv-file-more-fg:#3F5768;
    --bcv-chg-add-fg:#1E5C3E;--bcv-chg-add-bg:rgba(63,107,79,.16);--bcv-chg-modify-fg:#7A4E0E;--bcv-chg-modify-bg:rgba(169,107,73,.20);
    --bcv-chg-delete-fg:#8E1F2E;--bcv-chg-delete-bg:rgba(169,97,91,.16);--bcv-chg-keep-fg:#4E5A45;--bcv-chg-keep-bg:rgba(58,98,114,.12)}


 /* --- 主题二:流光玻璃(glass)玻璃拟态——高透面板/强模糊/顶部光晕/细白边 --- */
  body.theme-glass{--bg:#232030;--window-bg:rgba(40,35,60,.6);--glass:rgba(255,255,255,.07);--glass2:rgba(255,255,255,.12);
    --border:rgba(255,255,255,.3);--border-soft:rgba(255,255,255,.14);
    --text:#f4f1fb;--muted:#b6b0d2;--faint:#8882ab;
    --bronze:#c4b5fd;--bronze-dim:#8b7bd8;--bronze-glow:rgba(196,181,253,.45);
    --accent-bright:#e4dcff;--accent-soft:rgba(196,181,253,.18);--accent2:#f0abfc;
    --grad-a:#c4b5fd;--grad-b:#f0abfc;
    --reply:#efe9ff;--brand:#e4dcff;
    --green:#86efac;--red:#fda4af;--warn:#fde68a;
    --hover-bg:rgba(255,255,255,.1);--hover-bg2:rgba(255,255,255,.17);--on-accent:#2a2440;
    --input-bg:rgba(255,255,255,.09);--input-border:rgba(255,255,255,.2);--code-bg:rgba(20,16,34,.55);--sunken:rgba(255,255,255,.06);
    --chip-bg:rgba(255,255,255,.12);--overlay:rgba(30,26,48,.5);--solid:#2c2742;
    --scrollbar:rgba(255,255,255,.32);--focus-ring:rgba(196,181,253,.85);
    --bubble-a:rgba(196,181,253,.2);--bubble-b:rgba(240,171,252,.08);
 /* 语义色板(glass 流光玻璃:柔和粉彩族色) */
    --tok-func:#ffd98e;--tok-type:#8ee6d2;--tok-var:#b9c8ff;--tok-num:#ffb38a;
    --tok-str:#f2a6c4;--tok-bool:#c0b0ff;--tok-enum:#9fd8ff;--tok-comment:#857da8;
 /* 板色(glass:半透白叠层,玻璃质感靠 blur 不靠厚底) */
    --surf-code:rgba(20,16,34,.42);--surf-term:rgba(12,10,24,.6);--surf-json:rgba(255,255,255,.07);
    --surf-hit:rgba(196,181,253,.1);--surf-card:rgba(255,255,255,.06);--surf-fail:rgba(253,164,175,.12);
 /* 动效变量(glass:柔光浮动=柔曲线+时长+20%,位移稍大) */
    --anim-dur-fast:160ms;--anim-dur-base:230ms;--anim-dur-slow:340ms;
    --anim-ease:cubic-bezier(.3,.6,.3,1);--view-shift:8px;--anim-decor:0}
  body.theme-glass::before{background:
    radial-gradient(800px 560px at 78% 4%,rgba(196,181,253,.16),transparent 62%),
    radial-gradient(700px 520px at 8% 90%,rgba(240,171,252,.11),transparent 60%),
    radial-gradient(ellipse at 50% 50%,transparent 55%,rgba(20,16,34,.42) 100%)}
  body.theme-glass #sidebar,body.theme-glass .cc-box,body.theme-glass .perm-box,body.theme-glass .db-card,
  body.theme-glass .fv-box,body.theme-glass .uid-box{backdrop-filter:blur(26px) saturate(1.35)}
  body.theme-glass button{background:rgba(255,255,255,.06)}
 /* 白板配色:流光玻璃(glass,深色只微调紫调) —— 白板 CSS 区只吃 --bcv-*,此处集中覆写(派生自本主题 --window-bg/--text/--muted/--border) */
  body.theme-glass{
    --bcv-canvas-bg:rgba(26,22,42,.52);--bcv-grid-dot:rgba(196,181,253,.13);--bcv-float-bg:rgba(40,35,60,.92);--bcv-float-bg-dim:rgba(40,35,60,.60);--bcv-float-bg-solid:rgba(40,35,60,.97);--bcv-card-bg:rgba(44,39,66,.86);
    --bcv-card-bd:rgba(255,255,255,.22);--bcv-card-head-bg:rgba(196,181,253,.14);--bcv-card-shadow:rgba(10,8,22,.50);--bcv-title-fg:#f4f1fb;--bcv-sum-fg:#b6b0d2;--bcv-foot-fg:#b6b0d2;
    --bcv-on-accent:#2a2440;--bcv-lane-bg:rgba(255,255,255,.06);--bcv-lane-bd:rgba(255,255,255,.22);--bcv-lane-orphan-bd:rgba(255,255,255,.20);--bcv-lane-orphan-bg:rgba(255,255,255,.03);--bcv-lane-h-fg:#e4dcff;
    --bcv-lane-h-bg:rgba(20,16,34,.50);--bcv-lane-no-fg:#2a2440;--bcv-lane-seg-fg:#8882ab;--bcv-lane-1:#d8b98a;--bcv-lane-2:#8fb8ff;--bcv-lane-3:#86efac;
 /* 文字清晰度:强对比档(同色系加深/提亮,消除浅底上的淡彩小字) */
    --bcv-lane-h-fg-strong:#e4dcff;--bcv-lane-seg-fg:#B3ACD8;--bcv-lane-seg-fg-strong:#B3ACD8;
    --bcv-lane-1-fg-strong:#f0d39a;--bcv-lane-2-fg-strong:#b8d4ff;--bcv-lane-3-fg-strong:#b8e6cd;
    --bcv-lane-4-fg-strong:#f0bfd0;--bcv-lane-5-fg-strong:#d8c2f0;--bcv-lane-6-fg-strong:#96d8e4;
    --bcv-chip-info-fg:#c9bda6;--bcv-chip-role-fg:#e0c08f;--bcv-chip-ok-fg:#a9e6db;--bcv-chip-warn-fg:#f6c9a0;
    --bcv-chip-bad-fg:#f7b6c0;--bcv-chip-branch-fg:#c3dcff;--bcv-chip-before-fg:#c9c0b2;--bcv-chip-target-fg:#a9c8ff;--bcv-chip-metric-fg:#f0e3c8;
    --bcv-lane-4:#f0abfc;--bcv-lane-5:#c4b5fd;--bcv-lane-6:#7fd6e6;--bcv-lane-1-bg:rgba(216,185,138,.12);--bcv-lane-2-bg:rgba(143,184,255,.12);--bcv-lane-3-bg:rgba(134,239,172,.12);
    --bcv-lane-4-bg:rgba(240,171,252,.12);--bcv-lane-5-bg:rgba(196,181,253,.12);--bcv-lane-6-bg:rgba(127,214,230,.10);--bcv-lane-1-fg:#f0d9ae;--bcv-lane-2-fg:#cfe0ff;--bcv-lane-3-fg:#c8f7d8;
    --bcv-lane-4-fg:#ffd6fe;--bcv-lane-5-fg:#e4dcff;--bcv-lane-6-fg:#c8f0f5;--bcv-pill-bg:rgba(30,50,40,.90);--bcv-pill-bd:#86efac;--bcv-pill-fg:#eafaf0;
    --bcv-pill-fg-dim:#a8c8b8;--bcv-pill-end-bg:rgba(48,40,64,.94);--bcv-pill-end-bd:#d8b98a;--bcv-diamond-bg:rgba(50,42,68,.94);--bcv-diamond-bd:#d8b98a;--bcv-diamond-fg:#f0d9ae;
    --bcv-diamond-fg-dim:#c7c0e0;--bcv-diamond-glow:rgba(196,181,253,.22);--bcv-code-bg:rgba(32,28,52,.92);--bcv-code-bd:rgba(196,181,253,.40);--bcv-code-fg:#e2dcf5;--bcv-code-sum-fg:#cfc8e8;
    --bcv-code-kind-fg:#cfc0ff;--bcv-code-glyph:#d8b98a;--bcv-code-line-bd:rgba(196,181,253,.30);--bcv-code-line-first:rgba(216,185,138,.60);--bcv-code-tech-fg:#a8e6bc;--bcv-code-tech-bg:rgba(134,239,172,.10);
    --bcv-code-tech-bd:rgba(134,239,172,.25);--bcv-code-bg-module:rgba(32,40,66,.92);--bcv-code-bd-module:#8fb8ff;--bcv-code-bg-fn:rgba(30,34,60,.92);--bcv-code-bd-fn:#a9c8ff;--bcv-code-bg-tool:rgba(44,38,58,.92);
    --bcv-code-bd-tool:rgba(255,255,255,.30);--bcv-code-bg-agent:rgba(28,46,52,.92);--bcv-code-bd-agent:#7fd6e6;--bcv-code-bg-io:rgba(28,48,40,.92);--bcv-code-bd-io:#86efac;--bcv-code-bg-dec:rgba(50,42,68,.94);--bcv-thead-bg:rgba(30,26,48,.94);--bcv-thead-bd:rgba(196,181,253,.30);--bcv-thead-fg:#e4dcff;--bcv-thead-shadow:0 6px 18px rgba(0,0,0,.45);
    --bcv-code-bd-dec:#d8b98a;--bcv-code-bg-term:rgba(46,40,62,.94);--bcv-code-bd-term:#d8b98a;--bcv-code-edge-call:#a9c8ff;--bcv-code-edge-data:#86efac;--bcv-code-edge-verify:#d8b98a;
    --bcv-side-bg:rgba(36,31,56,.90);--bcv-side-bd:rgba(196,181,253,.30);--bcv-side-bd-mid:rgba(196,181,253,.20);--bcv-side-bd-soft:rgba(196,181,253,.12);--bcv-side-fg:#e4dcff;--bcv-side-fg-2:#cfc0ff;
    --bcv-side-fg-3:#f4f1fb;--bcv-side-fg-dim:#a8a2c8;--bcv-side-fg-dim2:#b8b0e0;--bcv-side-p-fg:#c8c2dd;--bcv-legend-bg:rgba(40,35,60,.86);--bcv-legend-bd:rgba(255,255,255,.20);
    --bcv-legend-fg:#e4dcff;--bcv-legend-fg-dim:#b6b0d2;--bcv-edge-line:rgba(255,255,255,.42);--bcv-edge-call:#c98f45;--bcv-edge-data:#8fb8ff;--bcv-edge-verify:#86efac;
    --bcv-edge-contains:rgba(255,255,255,.30);--bcv-edge-back:rgba(255,255,255,.32);--bcv-edge-main:#d8b98a;--bcv-accent:#d8b98a;--bcv-accent-2:#c4b5fd;--bcv-edge-label:#e4dcff;
    --bcv-edge-label-halo:rgba(20,16,34,.92);--bcv-edge-label-bg:rgba(20,16,34,.88);--bcv-edge-dot-bd:rgba(0,0,0,.40);--bcv-wire-page-bd:#c4b5fd;--bcv-wire-page-bg:rgba(44,39,66,.90);--bcv-wire-page-head:rgba(196,181,253,.16);
    --bcv-wire-page-head-bd:rgba(196,181,253,.40);--bcv-wire-section-bd:rgba(255,255,255,.28);--bcv-wire-section-bg:rgba(36,31,56,.82);--bcv-wire-component-bd:rgba(255,255,255,.22);--bcv-wire-component-bg:rgba(36,31,56,.78);--bcv-wire-nav-bd:#8fb8ff;
    --bcv-wire-nav-bg:rgba(30,34,60,.90);--bcv-wire-title-fg:#e4dcff;--bcv-wire-sum-fg:#cfc8e8;--bcv-wire-foot-fg:#a8a2c8;--bcv-wire-url-bg:rgba(0,0,0,.28);--bcv-wire-bg:rgba(40,35,60,.90);--bcv-flow-main:#86efac;--bcv-pgmain-ring:rgba(196,181,253,.70);
    --bcv-pgmain-glow:rgba(196,181,253,.22);--bcv-dot-idle:rgba(255,255,255,.32);--bcv-dot-ok:#86efac;--bcv-dot-warn:#fde68a;--bcv-dot-bad:#fda4af;--bcv-port-bd:#232030;
    --bcv-file-fg:#b6b0d2;--bcv-page-1-bg:rgba(40,44,66,.90);--bcv-page-2-bg:rgba(32,50,42,.90);--bcv-page-3-bg:rgba(34,38,66,.90);--bcv-page-4-bg:rgba(50,36,60,.90);--bcv-page-5-bg:rgba(54,40,42,.90);
    --bcv-doc-root-bg1:rgba(58,50,88,.95);--bcv-doc-root-bg2:rgba(38,33,56,.95);--bcv-doc-root-bd:rgba(255,255,255,.30);--bcv-doc-root-tag-fg:#2a2440;--bcv-doc-root-tag-bg:#c4b5fd;
    --bcv-doc-root-title:#f4f1fb;--bcv-doc-root-sum:#b6b0d2;--bcv-doc-ch-h:#f4f1fb;--bcv-doc-ch-hb-fg:#2a2440;--bcv-doc-ch-hb-bg:#c4b5fd;--bcv-doc-ch-n:#b3aed6;--bcv-doc-ch-sum:#b6b0d2;
    --bcv-doc-page-bg:rgba(44,39,66,.90);--bcv-doc-page-bd:rgba(255,255,255,.22);--bcv-doc-pg-h:#f4f1fb;--bcv-doc-pg-hb:#c4b5fd;--bcv-doc-pg-hb-bd:rgba(196,181,253,.35);--bcv-doc-pg-sum:#b6b0d2;
    --bcv-doc-shadow:rgba(10,8,22,.50);--bcv-doc-shadow-soft:rgba(10,8,22,.40);
    --bcv-file-name-fg:#c8dff8;--bcv-file-name-bg:rgba(196,181,253,.14);--bcv-file-name-bd:rgba(196,181,253,.40);
    --bcv-file-foot-fg:#b6cfe6;--bcv-file-sep-fg:#9a93b8;--bcv-file-more-fg:#aca6c8;
    --bcv-chg-add-fg:#a9d49a;--bcv-chg-add-bg:rgba(134,239,172,.14);--bcv-chg-modify-fg:#d7a262;--bcv-chg-modify-bg:rgba(216,185,138,.18);
    --bcv-chg-delete-fg:#eda197;--bcv-chg-delete-bg:rgba(240,171,252,.16);--bcv-chg-keep-fg:#cfc8e8;--bcv-chg-keep-bg:rgba(196,181,253,.12)}

  body.theme-glass button:hover{background:rgba(255,255,255,.12)}
  body.theme-glass .send-btn:hover{box-shadow:0 0 18px rgba(196,181,253,.5)}

 /* --- 主题三:橄榄赤陶(olive)灰紫底/赤陶主色/橄榄绿——浅色、无辉光 --- */
  body.theme-olive{--bg:#CDCBD6;--window-bg:#D8D6DF;--glass:rgba(250,249,253,.55);--glass2:rgba(250,249,253,.72);
    --border:rgba(47,48,32,.28);--border-soft:rgba(47,48,32,.13);
    --text:#2F3020;--muted:#5C604A;--faint:#8C8F7E;
    --bronze:#D96846;--bronze-dim:#A94A2F;--bronze-glow:rgba(217,104,70,.38);
    --accent-bright:#A63D22;--accent-soft:rgba(217,104,70,.15);--accent2:#596235;
    --grad-a:#D96846;--grad-b:#B34E30;
    --reply:#3A3B28;--brand:#2F3020;
    --green:#596235;--red:#A8402E;--warn:#8A6A20;
    --hover-bg:rgba(47,48,32,.06);--hover-bg2:rgba(47,48,32,.10);--on-accent:#FFF8F4;
    --input-bg:rgba(250,249,253,.76);--input-border:rgba(47,48,32,.20);--code-bg:#C6C4D0;--sunken:rgba(47,48,32,.06);
    --chip-bg:rgba(47,48,32,.08);--overlay:rgba(47,48,32,.35);--solid:#E3E1E9;
    --scrollbar:rgba(47,48,32,.28);--focus-ring:rgba(217,104,70,.68);
    --bubble-a:rgba(217,104,70,.16);--bubble-b:rgba(217,104,70,.06);
 /* 语义色板(olive:橄榄/赤陶族色,冷紫底暖字) */
    --tok-func:#7A4A20;--tok-type:#596235;--tok-var:#3A4F3A;--tok-num:#B04E2A;
    --tok-str:#8A3A3A;--tok-bool:#4F5C2B;--tok-enum:#6B4A2F;--tok-comment:#8C8F7E;
 /* 板色(olive:灰紫薄板,橄榄边) */
    --surf-code:rgba(47,48,32,.06);--surf-term:rgba(47,48,32,.10);--surf-json:rgba(47,48,32,.04);
    --surf-hit:rgba(217,104,70,.10);--surf-card:rgba(47,48,32,.03);--surf-fail:rgba(168,64,46,.07);
 /* 动效变量(olive:浅色柔和,无装饰循环) */
    --anim-dur-fast:140ms;--anim-dur-base:200ms;--anim-dur-slow:300ms;--view-shift:4px;--anim-decor:0}
  body.theme-olive::before{background:
    radial-gradient(900px 600px at 85% 8%,rgba(217,104,70,.10),transparent 60%),
    radial-gradient(700px 500px at 10% 90%,rgba(89,98,53,.08),transparent 60%),
    radial-gradient(ellipse at 50% 50%,transparent 60%,rgba(47,48,32,.10) 100%)}
  body.theme-olive #sidebar,body.theme-olive .sb-acts{background:rgba(216,214,223,.9)}
  body.theme-olive .cc-box{background:#F0EFF4;color:var(--text)}
 /* 白板配色:橄榄石(olive) —— 白板 CSS 区只吃 --bcv-*,此处集中覆写(派生自本主题 --window-bg/--text/--muted/--border) */
  body.theme-olive{
    --bcv-canvas-bg:rgba(216,214,223,.72);--bcv-grid-dot:rgba(47,48,32,.16);--bcv-float-bg:rgba(240,239,246,.96);--bcv-float-bg-dim:rgba(240,239,246,.90);--bcv-float-bg-solid:rgba(240,239,246,.98);--bcv-card-bg:#E3E1E9;
    --bcv-card-bd:rgba(47,48,32,.26);--bcv-card-head-bg:rgba(217,104,70,.14);--bcv-card-shadow:rgba(30,30,25,.14);--bcv-title-fg:#2F3020;--bcv-sum-fg:#5C604A;--bcv-foot-fg:#5C604A;
    --bcv-on-accent:#FFF8F4;--bcv-lane-bg:rgba(47,48,32,.05);--bcv-lane-bd:rgba(47,48,32,.22);--bcv-lane-orphan-bd:#8C8F7E;--bcv-lane-orphan-bg:rgba(47,48,32,.05);--bcv-lane-h-fg:#2F3020;
    --bcv-lane-h-bg:rgba(240,239,246,.86);--bcv-lane-no-fg:#FFF8F4;--bcv-lane-seg-fg:#8C8F7E;--bcv-lane-1:#B85A3C;--bcv-lane-2:#4A6FA8;--bcv-lane-3:#596235;
 /* 文字清晰度:强对比档(同色系加深/提亮,消除浅底上的淡彩小字) */
    --bcv-lane-h-fg-strong:#3A2E1C;--bcv-lane-seg-fg:#464A34;--bcv-lane-seg-fg-strong:#464A34;
    --bcv-lane-1-fg-strong:#5E3E0C;--bcv-lane-2-fg-strong:#1F4C7A;--bcv-lane-3-fg-strong:#174E33;
    --bcv-lane-4-fg-strong:#6E2440;--bcv-lane-5-fg-strong:#4A2F7A;--bcv-lane-6-fg-strong:#0F5460;
    --bcv-chip-info-fg:#544C3E;--bcv-chip-role-fg:#7A4E0E;--bcv-chip-ok-fg:#0F5C52;--bcv-chip-warn-fg:#8A4A12;
    --bcv-chip-bad-fg:#8E1F2E;--bcv-chip-branch-fg:#26538F;--bcv-chip-before-fg:#57503F;--bcv-chip-target-fg:#1F4272;--bcv-chip-metric-fg:#6E4B0D;
    --bcv-lane-4:#8C4A6A;--bcv-lane-5:#6B5A9A;--bcv-lane-6:#3F7A88;--bcv-lane-1-bg:rgba(184,90,60,.10);--bcv-lane-2-bg:rgba(74,111,168,.10);--bcv-lane-3-bg:rgba(89,98,53,.10);
    --bcv-lane-4-bg:rgba(140,74,106,.10);--bcv-lane-5-bg:rgba(107,90,154,.10);--bcv-lane-6-bg:rgba(63,122,136,.08);--bcv-lane-1-fg:#7A3A22;--bcv-lane-2-fg:#2F4A78;--bcv-lane-3-fg:#37401F;
    --bcv-lane-4-fg:#6B3546;--bcv-lane-5-fg:#45385E;--bcv-lane-6-fg:#235058;--bcv-pill-bg:#EDF1E6;--bcv-pill-bd:#596235;--bcv-pill-fg:#232B18;
    --bcv-pill-fg-dim:#5C604A;--bcv-pill-end-bg:#F4EAE2;--bcv-pill-end-bd:#B85A3C;--bcv-diamond-bg:#F4EAE2;--bcv-diamond-bd:#B85A3C;--bcv-diamond-fg:#7A3A20;
    --bcv-diamond-fg-dim:#5C604A;--bcv-diamond-glow:rgba(184,90,60,.18);--bcv-code-bg:#F2F2F6;--bcv-code-bd:#8A8C7A;--bcv-code-fg:#2F3222;--bcv-code-sum-fg:#44473A;
    --bcv-code-kind-fg:#3A5C66;--bcv-code-glyph:#B85A3C;--bcv-code-line-bd:rgba(74,90,120,.26);--bcv-code-line-first:rgba(184,90,60,.60);--bcv-code-tech-fg:#4A6A46;--bcv-code-tech-bg:rgba(89,98,53,.10);
    --bcv-code-tech-bd:rgba(89,98,53,.25);--bcv-code-bg-module:#EEF0F6;--bcv-code-bd-module:#4A5A78;--bcv-code-bg-fn:#EDF0F8;--bcv-code-bd-fn:#3F4F86;--bcv-code-bg-tool:#F4F3EE;
    --bcv-code-bd-tool:#93957F;--bcv-code-bg-agent:#EDF4F4;--bcv-code-bd-agent:#3F7A88;--bcv-code-bg-io:#EFF4EA;--bcv-code-bd-io:#596235;--bcv-code-bg-dec:#F4EAE2;--bcv-thead-bg:rgba(243,242,248,.95);--bcv-thead-bd:rgba(47,48,32,.26);--bcv-thead-fg:#2F3020;--bcv-thead-shadow:0 6px 18px rgba(47,48,32,.14);
    --bcv-code-bd-dec:#B85A3C;--bcv-code-bg-term:#F4EAE2;--bcv-code-bd-term:#B85A3C;--bcv-code-edge-call:#4A5A78;--bcv-code-edge-data:#596235;--bcv-code-edge-verify:#B85A3C;
    --bcv-side-bg:#E3E1E9;--bcv-side-bd:rgba(47,48,32,.26);--bcv-side-bd-mid:rgba(47,48,32,.18);--bcv-side-bd-soft:rgba(47,48,32,.12);--bcv-side-fg:#2F3020;--bcv-side-fg-2:#4A5A78;
    --bcv-side-fg-3:#232B18;--bcv-side-fg-dim:#5C604A;--bcv-side-fg-dim2:#4A5A78;--bcv-side-p-fg:#3F4030;--bcv-legend-bg:rgba(240,239,246,.92);--bcv-legend-bd:rgba(47,48,32,.20);
    --bcv-legend-fg:#2F3020;--bcv-legend-fg-dim:#5C604A;--bcv-edge-line:#8C8F7E;--bcv-edge-call:#B85A3C;--bcv-edge-data:#4A5A78;--bcv-edge-verify:#596235;
    --bcv-edge-contains:#8C8F7E;--bcv-edge-back:#8C8F7E;--bcv-edge-main:#A84E32;--bcv-accent:#A84E32;--bcv-accent-2:#B85A3C;--bcv-edge-label:#2F3020;
    --bcv-edge-label-halo:rgba(240,239,246,.92);--bcv-edge-label-bg:rgba(240,239,246,.92);--bcv-edge-dot-bd:rgba(255,255,255,.55);--bcv-wire-page-bd:#D96846;--bcv-wire-page-bg:#F0EFF4;--bcv-wire-page-head:rgba(217,104,70,.14);
    --bcv-wire-page-head-bd:rgba(217,104,70,.40);--bcv-wire-section-bd:#8C8F7E;--bcv-wire-section-bg:#E9E8EF;--bcv-wire-component-bd:#A0A29A;--bcv-wire-component-bg:#EDECF2;--bcv-wire-nav-bd:#596235;
    --bcv-wire-nav-bg:#E9EBE6;--bcv-wire-title-fg:#2F3020;--bcv-wire-sum-fg:#5C604A;--bcv-wire-foot-fg:#5C604A;--bcv-wire-url-bg:rgba(47,48,32,.06);--bcv-wire-bg:#EDECF2;--bcv-flow-main:#596235;--bcv-pgmain-ring:rgba(217,104,70,.72);
    --bcv-pgmain-glow:rgba(217,104,70,.20);--bcv-dot-idle:#8C8F7E;--bcv-dot-ok:#596235;--bcv-dot-warn:#8A6A20;--bcv-dot-bad:#A8402E;--bcv-port-bd:#E3E1E9;
    --bcv-file-fg:#5C604A;--bcv-page-1-bg:#F2F1F6;--bcv-page-2-bg:#EFF3EE;--bcv-page-3-bg:#EDF0F6;--bcv-page-4-bg:#F4EFF2;--bcv-page-5-bg:#F6F1EA;
    --bcv-doc-root-bg1:rgba(242,241,246,.97);--bcv-doc-root-bg2:rgba(233,232,240,.97);--bcv-doc-root-bd:rgba(47,48,32,.28);--bcv-doc-root-tag-fg:#F2F1F6;--bcv-doc-root-tag-bg:#2F3020;
    --bcv-doc-root-title:#2F3020;--bcv-doc-root-sum:#5C604A;--bcv-doc-ch-h:#2F3020;--bcv-doc-ch-hb-fg:#F2F1F6;--bcv-doc-ch-hb-bg:#2F3020;--bcv-doc-ch-n:#555A44;--bcv-doc-ch-sum:#5C604A;
    --bcv-doc-page-bg:rgba(238,237,243,.96);--bcv-doc-page-bd:rgba(47,48,32,.22);--bcv-doc-pg-h:#2F3020;--bcv-doc-pg-hb:#5C604A;--bcv-doc-pg-hb-bd:rgba(47,48,32,.28);--bcv-doc-pg-sum:#5C604A;
    --bcv-doc-shadow:rgba(30,30,20,.12);--bcv-doc-shadow-soft:rgba(30,30,20,.10);
    --bcv-file-name-fg:#1B4A73;--bcv-file-name-bg:rgba(74,111,168,.12);--bcv-file-name-bd:rgba(74,111,168,.45);
    --bcv-file-foot-fg:#33566F;--bcv-file-sep-fg:#4E6273;--bcv-file-more-fg:#3F5768;
    --bcv-chg-add-fg:#1E5C3E;--bcv-chg-add-bg:rgba(89,98,53,.16);--bcv-chg-modify-fg:#7A4E0E;--bcv-chg-modify-bg:rgba(184,90,60,.18);
    --bcv-chg-delete-fg:#8E1F2E;--bcv-chg-delete-bg:rgba(140,74,106,.16);--bcv-chg-keep-fg:#4E523F;--bcv-chg-keep-bg:rgba(74,111,168,.12)}


 /* --- 主题四:蓝调梅影(plum)奶油底/梅紫主色/板岩蓝——浅色、无辉光 --- */
  body.theme-plum{--bg:#F2EBE5;--window-bg:#F8F3EE;--glass:rgba(255,253,250,.55);--glass2:rgba(255,253,250,.72);
    --border:rgba(43,38,45,.28);--border-soft:rgba(43,38,45,.13);
    --text:#2B262D;--muted:#6B6470;--faint:#9A939C;
    --bronze:#9F496E;--bronze-dim:#7D3755;--bronze-glow:rgba(159,73,110,.38);
    --accent-bright:#843A5B;--accent-soft:rgba(159,73,110,.14);--accent2:#647295;
    --grad-a:#9F496E;--grad-b:#7D3755;
    --reply:#3A2F38;--brand:#2B262D;
    --green:#4F6B5A;--red:#A84A4A;--warn:#9A6A2F;
    --hover-bg:rgba(43,38,45,.06);--hover-bg2:rgba(43,38,45,.10);--on-accent:#FFF8FA;
    --input-bg:rgba(255,253,250,.76);--input-border:rgba(43,38,45,.20);--code-bg:#E8E1DA;--sunken:rgba(43,38,45,.06);
    --chip-bg:rgba(43,38,45,.08);--overlay:rgba(43,38,45,.35);--solid:#FBF7F3;
    --scrollbar:rgba(43,38,45,.28);--focus-ring:rgba(159,73,110,.68);
    --bubble-a:rgba(159,73,110,.16);--bubble-b:rgba(159,73,110,.06);
 /* 语义色板(plum:梅紫/板岩蓝族色,奶油底) */
    --tok-func:#7A3F5C;--tok-type:#4C5C82;--tok-var:#3E4A66;--tok-num:#9A5A2E;
    --tok-str:#8E3B5A;--tok-bool:#2F5D6B;--tok-enum:#6B4A7A;--tok-comment:#9A939C;
 /* 板色(plum:奶油薄板+梅紫边) */
    --surf-code:rgba(43,38,45,.06);--surf-term:rgba(43,38,45,.10);--surf-json:rgba(43,38,45,.04);
    --surf-hit:rgba(159,73,110,.10);--surf-card:rgba(43,38,45,.03);--surf-fail:rgba(168,74,74,.07);
 /* 动效变量(plum:浅色柔和,无装饰循环) */
    --anim-dur-fast:140ms;--anim-dur-base:200ms;--anim-dur-slow:300ms;--view-shift:4px;--anim-decor:0}
  body.theme-plum::before{background:
    radial-gradient(900px 600px at 85% 8%,rgba(159,73,110,.09),transparent 60%),
    radial-gradient(700px 500px at 10% 90%,rgba(100,114,149,.08),transparent 60%),
    radial-gradient(ellipse at 50% 50%,transparent 60%,rgba(43,38,45,.10) 100%)}
  body.theme-plum #sidebar,body.theme-plum .sb-acts{background:rgba(248,243,238,.9)}
  body.theme-plum .cc-box{background:#FCF8F4;color:var(--text)}
 /* 白板配色:梅紫(plum) —— 白板 CSS 区只吃 --bcv-*,此处集中覆写(派生自本主题 --window-bg/--text/--muted/--border) */
  body.theme-plum{
    --bcv-canvas-bg:rgba(248,243,238,.72);--bcv-grid-dot:rgba(159,73,110,.18);--bcv-float-bg:rgba(252,248,244,.96);--bcv-float-bg-dim:rgba(252,248,244,.90);--bcv-float-bg-solid:rgba(252,248,244,.98);--bcv-card-bg:#FCF8F4;
    --bcv-card-bd:rgba(43,38,45,.28);--bcv-card-head-bg:rgba(159,73,110,.13);--bcv-card-shadow:rgba(43,38,45,.14);--bcv-title-fg:#2B262D;--bcv-sum-fg:#6B6470;--bcv-foot-fg:#6B6470;
    --bcv-on-accent:#FFF8F1;--bcv-lane-bg:rgba(43,38,45,.05);--bcv-lane-bd:rgba(43,38,45,.22);--bcv-lane-orphan-bd:#9A939C;--bcv-lane-orphan-bg:rgba(43,38,45,.05);--bcv-lane-h-fg:#2B262D;
    --bcv-lane-h-bg:rgba(252,248,244,.86);--bcv-lane-no-fg:#FFF8F1;--bcv-lane-seg-fg:#9A939C;--bcv-lane-1:#A8632F;--bcv-lane-2:#4A5E86;--bcv-lane-3:#4F6B5A;
 /* 文字清晰度:强对比档(同色系加深/提亮,消除浅底上的淡彩小字) */
    --bcv-lane-h-fg-strong:#3A2E1C;--bcv-lane-seg-fg:#5A5460;--bcv-lane-seg-fg-strong:#5A5460;
    --bcv-lane-1-fg-strong:#6E4A12;--bcv-lane-2-fg-strong:#1F4C7A;--bcv-lane-3-fg-strong:#1E5C3E;
    --bcv-lane-4-fg-strong:#6E2440;--bcv-lane-5-fg-strong:#4A2F7A;--bcv-lane-6-fg-strong:#0F5460;
    --bcv-chip-info-fg:#544C3E;--bcv-chip-role-fg:#7A4E0E;--bcv-chip-ok-fg:#0F5C52;--bcv-chip-warn-fg:#8A4A12;
    --bcv-chip-bad-fg:#8E1F2E;--bcv-chip-branch-fg:#26538F;--bcv-chip-before-fg:#57503F;--bcv-chip-target-fg:#1F4272;--bcv-chip-metric-fg:#6E4B0D;
    --bcv-lane-4:#9F496E;--bcv-lane-5:#6A4E9A;--bcv-lane-6:#2F6E7E;--bcv-lane-1-bg:rgba(168,99,47,.10);--bcv-lane-2-bg:rgba(74,94,134,.10);--bcv-lane-3-bg:rgba(79,107,90,.10);
    --bcv-lane-4-bg:rgba(159,73,110,.10);--bcv-lane-5-bg:rgba(106,78,154,.10);--bcv-lane-6-bg:rgba(47,110,126,.08);--bcv-lane-1-fg:#6E411F;--bcv-lane-2-fg:#2F4868;--bcv-lane-3-fg:#374838;
    --bcv-lane-4-fg:#7A3452;--bcv-lane-5-fg:#453566;--bcv-lane-6-fg:#235058;--bcv-pill-bg:#F0F6F2;--bcv-pill-bd:#4F6B5A;--bcv-pill-fg:#23372C;
    --bcv-pill-fg-dim:#6B6470;--bcv-pill-end-bg:#F8EDF1;--bcv-pill-end-bd:#9F496E;--bcv-diamond-bg:#F8EDF1;--bcv-diamond-bd:#9F496E;--bcv-diamond-fg:#6E2F4C;
    --bcv-diamond-fg-dim:#6B6470;--bcv-diamond-glow:rgba(159,73,110,.18);--bcv-code-bg:#F6F7F9;--bcv-code-bd:#94979E;--bcv-code-fg:#2B262D;--bcv-code-sum-fg:#4A4550;
    --bcv-code-kind-fg:#3A4A6B;--bcv-code-glyph:#A8632F;--bcv-code-line-bd:rgba(74,94,134,.26);--bcv-code-line-first:rgba(159,73,110,.60);--bcv-code-tech-fg:#3F5F52;--bcv-code-tech-bg:rgba(79,107,90,.10);
    --bcv-code-tech-bd:rgba(79,107,90,.25);--bcv-code-bg-module:#F1F4F9;--bcv-code-bd-module:#4A5E86;--bcv-code-bg-fn:#F1F3FA;--bcv-code-bd-fn:#3F5AA0;--bcv-code-bg-tool:#F7F3EE;
    --bcv-code-bd-tool:#A79AA0;--bcv-code-bg-agent:#EFF5F6;--bcv-code-bd-agent:#2F6E7E;--bcv-code-bg-io:#F1F5F2;--bcv-code-bd-io:#4F6B5A;--bcv-code-bg-dec:#F8EDF1;--bcv-thead-bg:rgba(253,249,246,.95);--bcv-thead-bd:rgba(43,38,45,.26);--bcv-thead-fg:#2B262D;--bcv-thead-shadow:0 6px 18px rgba(43,38,45,.14);
    --bcv-code-bd-dec:#9F496E;--bcv-code-bg-term:#F8EDF1;--bcv-code-bd-term:#9F496E;--bcv-code-edge-call:#4A5E86;--bcv-code-edge-data:#4F6B5A;--bcv-code-edge-verify:#A8632F;
    --bcv-side-bg:#FCF8F4;--bcv-side-bd:rgba(43,38,45,.26);--bcv-side-bd-mid:rgba(43,38,45,.18);--bcv-side-bd-soft:rgba(43,38,45,.12);--bcv-side-fg:#2B262D;--bcv-side-fg-2:#4A5E86;
    --bcv-side-fg-3:#241F26;--bcv-side-fg-dim:#6B6470;--bcv-side-fg-dim2:#4A5E86;--bcv-side-p-fg:#3F3A42;--bcv-legend-bg:rgba(252,248,244,.92);--bcv-legend-bd:rgba(43,38,45,.20);
    --bcv-legend-fg:#2B262D;--bcv-legend-fg-dim:#6B6470;--bcv-edge-line:#9A939C;--bcv-edge-call:#9F496E;--bcv-edge-data:#4A5E86;--bcv-edge-verify:#4F6B5A;
    --bcv-edge-contains:#9A939C;--bcv-edge-back:#9A939C;--bcv-edge-main:#8A3A5C;--bcv-accent:#8A3A5C;--bcv-accent-2:#9F496E;--bcv-edge-label:#2B262D;
    --bcv-edge-label-halo:rgba(252,248,244,.92);--bcv-edge-label-bg:rgba(252,248,244,.92);--bcv-edge-dot-bd:rgba(255,255,255,.55);--bcv-wire-page-bd:#9F496E;--bcv-wire-page-bg:#FCF8F4;--bcv-wire-page-head:rgba(159,73,110,.13);
    --bcv-wire-page-head-bd:rgba(159,73,110,.40);--bcv-wire-section-bd:#9A8C92;--bcv-wire-section-bg:#F8F1EC;--bcv-wire-component-bd:#A79AA0;--bcv-wire-component-bg:#FAF5F1;--bcv-wire-nav-bd:#4F6B5A;
    --bcv-wire-nav-bg:#F0F4F1;--bcv-wire-title-fg:#2B262D;--bcv-wire-sum-fg:#6B6470;--bcv-wire-foot-fg:#6B6470;--bcv-wire-url-bg:rgba(43,38,45,.06);--bcv-wire-bg:#FAF5F0;--bcv-flow-main:#4F6B5A;--bcv-pgmain-ring:rgba(159,73,110,.72);
    --bcv-pgmain-glow:rgba(159,73,110,.20);--bcv-dot-idle:#9A939C;--bcv-dot-ok:#4F6B5A;--bcv-dot-warn:#8A6A20;--bcv-dot-bad:#A84A4A;--bcv-port-bd:#FCF8F4;
    --bcv-file-fg:#6B6470;--bcv-page-1-bg:#F8F4F6;--bcv-page-2-bg:#F1F4F2;--bcv-page-3-bg:#F0F2F7;--bcv-page-4-bg:#F6EEF2;--bcv-page-5-bg:#F8F1EA;
    --bcv-doc-root-bg1:rgba(255,253,250,.97);--bcv-doc-root-bg2:rgba(248,243,238,.97);--bcv-doc-root-bd:rgba(43,38,45,.28);--bcv-doc-root-tag-fg:#FCF8F4;--bcv-doc-root-tag-bg:#2B262D;
    --bcv-doc-root-title:#2B262D;--bcv-doc-root-sum:#6B6470;--bcv-doc-ch-h:#2B262D;--bcv-doc-ch-hb-fg:#FCF8F4;--bcv-doc-ch-hb-bg:#2B262D;--bcv-doc-ch-n:#5F5866;--bcv-doc-ch-sum:#6B6470;
    --bcv-doc-page-bg:rgba(252,248,244,.96);--bcv-doc-page-bd:rgba(43,38,45,.22);--bcv-doc-pg-h:#2B262D;--bcv-doc-pg-hb:#6B6470;--bcv-doc-pg-hb-bd:rgba(43,38,45,.28);--bcv-doc-pg-sum:#6B6470;
    --bcv-doc-shadow:rgba(40,30,35,.12);--bcv-doc-shadow-soft:rgba(40,30,35,.10);
    --bcv-file-name-fg:#1B4A73;--bcv-file-name-bg:rgba(74,94,134,.12);--bcv-file-name-bd:rgba(74,94,134,.45);
    --bcv-file-foot-fg:#33566F;--bcv-file-sep-fg:#4E6273;--bcv-file-more-fg:#3F5768;
    --bcv-chg-add-fg:#1E5C3E;--bcv-chg-add-bg:rgba(79,107,90,.16);--bcv-chg-modify-fg:#7A4E0E;--bcv-chg-modify-bg:rgba(159,73,110,.16);
    --bcv-chg-delete-fg:#8E1F2E;--bcv-chg-delete-bg:rgba(159,73,110,.20);--bcv-chg-keep-fg:#56505C;--bcv-chg-keep-bg:rgba(74,94,134,.12)}


 /* --- 主题五:薄墨(ink)极简高对比——纸白底/纯黑字/单一朱红强调/零渐变零辉光 --- */
  body.theme-ink{--bg:#f6f6f4;--window-bg:#ffffff;--glass:rgba(255,255,255,.6);--glass2:rgba(255,255,255,.82);
    --border:rgba(17,17,17,.38);--border-soft:rgba(17,17,17,.14);
    --text:#141414;--muted:#5c5c58;--faint:#98978f;
    --bronze:#d43d2a;--bronze-dim:#a92c1d;--bronze-glow:rgba(212,61,42,.32);
    --accent-bright:#b02a1a;--accent-soft:rgba(212,61,42,.1);--accent2:#141414;
    --grad-a:#d43d2a;--grad-b:#8f1f12;
    --reply:#1f1f1f;--brand:#141414;
    --green:#2f7d32;--red:#c62828;--warn:#b26a00;
    --hover-bg:rgba(17,17,17,.05);--hover-bg2:rgba(17,17,17,.09);--on-accent:#ffffff;
    --input-bg:#ffffff;--input-border:rgba(17,17,17,.24);--code-bg:#f0efec;--sunken:#efeeea;
    --chip-bg:rgba(17,17,17,.07);--overlay:rgba(20,20,20,.42);--solid:#ffffff;
    --scrollbar:rgba(17,17,17,.3);--focus-ring:rgba(212,61,42,.7);
    --bubble-a:rgba(17,17,17,.06);--bubble-b:rgba(17,17,17,.02);
 /* 语义色板(ink 薄墨:克制单色——灰阶亮度分层,唯一朱红给类型强调) */
    --tok-func:#000000;--tok-type:#d43d2a;--tok-var:#333333;--tok-num:#666666;
    --tok-str:#777777;--tok-bool:#444444;--tok-enum:#555555;--tok-comment:#b5b3ad;
 /* 板色(ink:纸面灰阶板,零色彩——靠明度差与边框分层) */
    --surf-code:rgba(17,17,17,.055);--surf-term:rgba(17,17,17,.08);--surf-json:rgba(17,17,17,.035);
    --surf-hit:rgba(17,17,17,.05);--surf-card:rgba(17,17,17,.03);--surf-fail:rgba(198,40,40,.06);
 /* 动效变量(ink:克制几乎无动画——时长压至近即时、位移归零、装饰全关、无弹性) */
    --anim-dur-fast:60ms;--anim-dur-base:80ms;--anim-dur-slow:120ms;
    --anim-ease:linear;--anim-ease-soft:linear;--anim-ease-spring:linear;
    --view-shift:0px;--anim-decor:0}
  body.theme-ink::before{background:none}
  body.theme-ink #sidebar{background:rgba(255,255,255,.92);border-right:1px solid var(--border-soft)}
  body.theme-ink .sb-acts{background:rgba(255,255,255,.92)} /* 底部导航条随主题玻璃色 */
  body.theme-ink .cc-box{background:#ffffff;color:var(--text)}
 /* 白板配色:薄墨(ink) —— 白板 CSS 区只吃 --bcv-*,此处集中覆写(派生自本主题 --window-bg/--text/--muted/--border) */
  body.theme-ink{
    --bcv-canvas-bg:rgba(252,252,251,.86);--bcv-grid-dot:rgba(17,17,17,.14);--bcv-float-bg:rgba(255,255,255,.97);--bcv-float-bg-dim:rgba(255,255,255,.92);--bcv-float-bg-solid:rgba(255,255,255,1);--bcv-card-bg:#ffffff;
    --bcv-card-bd:rgba(17,17,17,.38);--bcv-card-head-bg:rgba(17,17,17,.05);--bcv-card-shadow:rgba(20,20,20,.10);--bcv-title-fg:#141414;--bcv-sum-fg:#5c5c58;--bcv-foot-fg:#5c5c58;
    --bcv-on-accent:#ffffff;--bcv-lane-bg:rgba(17,17,17,.03);--bcv-lane-bd:rgba(17,17,17,.20);--bcv-lane-orphan-bd:#98978f;--bcv-lane-orphan-bg:rgba(17,17,17,.04);--bcv-lane-h-fg:#141414;
    --bcv-lane-h-bg:rgba(255,255,255,.92);--bcv-lane-no-fg:#ffffff;--bcv-lane-seg-fg:#98978f;--bcv-lane-1:#d43d2a;--bcv-lane-2:#1f5fa0;--bcv-lane-3:#2f7d32;
 /* 文字清晰度:强对比档(同色系加深/提亮,消除浅底上的淡彩小字) */
    --bcv-lane-h-fg-strong:#3A2E1C;--bcv-lane-seg-fg:#5F5E58;--bcv-lane-seg-fg-strong:#5F5E58;
    --bcv-lane-1-fg-strong:#6E4A12;--bcv-lane-2-fg-strong:#1F4C7A;--bcv-lane-3-fg-strong:#1E5C3E;
    --bcv-lane-4-fg-strong:#6E2440;--bcv-lane-5-fg-strong:#4A2F7A;--bcv-lane-6-fg-strong:#0F5460;
    --bcv-chip-info-fg:#544C3E;--bcv-chip-role-fg:#7A4E0E;--bcv-chip-ok-fg:#0F5C52;--bcv-chip-warn-fg:#8A4A12;
    --bcv-chip-bad-fg:#8E1F2E;--bcv-chip-branch-fg:#26538F;--bcv-chip-before-fg:#57503F;--bcv-chip-target-fg:#1F4272;--bcv-chip-metric-fg:#6E4B0D;
    --bcv-lane-4:#a32f5f;--bcv-lane-5:#5a3fa0;--bcv-lane-6:#17616e;--bcv-lane-1-bg:rgba(212,61,42,.08);--bcv-lane-2-bg:rgba(31,95,160,.08);--bcv-lane-3-bg:rgba(47,125,50,.08);
    --bcv-lane-4-bg:rgba(163,47,95,.08);--bcv-lane-5-bg:rgba(90,63,160,.08);--bcv-lane-6-bg:rgba(23,97,110,.08);--bcv-lane-1-fg:#a82c1e;--bcv-lane-2-fg:#17497d;--bcv-lane-3-fg:#24612a;
    --bcv-lane-4-fg:#7d2249;--bcv-lane-5-fg:#452f7d;--bcv-lane-6-fg:#11505a;--bcv-pill-bg:#f2f8f3;--bcv-pill-bd:#2f7d32;--bcv-pill-fg:#141414;
    --bcv-pill-fg-dim:#5c5c58;--bcv-pill-end-bg:#fdf1ef;--bcv-pill-end-bd:#d43d2a;--bcv-diamond-bg:#fdf1ef;--bcv-diamond-bd:#d43d2a;--bcv-diamond-fg:#a82c1e;
    --bcv-diamond-fg-dim:#5c5c58;--bcv-diamond-glow:rgba(212,61,42,.16);--bcv-code-bg:#fbfbfa;--bcv-code-bd:#98978f;--bcv-code-fg:#141414;--bcv-code-sum-fg:#5c5c58;
    --bcv-code-kind-fg:#1f5fa0;--bcv-code-glyph:#a82c1e;--bcv-code-line-bd:rgba(31,95,160,.26);--bcv-code-line-first:rgba(212,61,42,.55);--bcv-code-tech-fg:#24612a;--bcv-code-tech-bg:rgba(47,125,50,.10);
    --bcv-code-tech-bd:rgba(47,125,50,.24);--bcv-code-bg-module:#f5f7fa;--bcv-code-bd-module:#1f5fa0;--bcv-code-bg-fn:#f4f6fb;--bcv-code-bd-fn:#2a55a0;--bcv-code-bg-tool:#fafaf8;
    --bcv-code-bd-tool:#98978f;--bcv-code-bg-agent:#f2f8f8;--bcv-code-bd-agent:#17616e;--bcv-code-bg-io:#f4f9f4;--bcv-code-bd-io:#2f7d32;--bcv-code-bg-dec:#fdf1ef;--bcv-thead-bg:rgba(255,255,255,.97);--bcv-thead-bd:rgba(17,17,17,.26);--bcv-thead-fg:#141414;--bcv-thead-shadow:0 6px 18px rgba(17,17,17,.12);
    --bcv-code-bd-dec:#d43d2a;--bcv-code-bg-term:#fdf1ef;--bcv-code-bd-term:#d43d2a;--bcv-code-edge-call:#1f5fa0;--bcv-code-edge-data:#2f7d32;--bcv-code-edge-verify:#d43d2a;
    --bcv-side-bg:#ffffff;--bcv-side-bd:rgba(17,17,17,.24);--bcv-side-bd-mid:rgba(17,17,17,.16);--bcv-side-bd-soft:rgba(17,17,17,.10);--bcv-side-fg:#141414;--bcv-side-fg-2:#1f5fa0;
    --bcv-side-fg-3:#141414;--bcv-side-fg-dim:#5c5c58;--bcv-side-fg-dim2:#1f5fa0;--bcv-side-p-fg:#3a3a36;--bcv-legend-bg:rgba(255,255,255,.96);--bcv-legend-bd:rgba(17,17,17,.20);
    --bcv-legend-fg:#141414;--bcv-legend-fg-dim:#5c5c58;--bcv-edge-line:#98978f;--bcv-edge-call:#d43d2a;--bcv-edge-data:#1f5fa0;--bcv-edge-verify:#2f7d32;
    --bcv-edge-contains:#98978f;--bcv-edge-back:#98978f;--bcv-edge-main:#c22f1f;--bcv-accent:#c22f1f;--bcv-accent-2:#d43d2a;--bcv-edge-label:#141414;
    --bcv-edge-label-halo:rgba(255,255,255,.92);--bcv-edge-label-bg:rgba(255,255,255,.92);--bcv-edge-dot-bd:rgba(17,17,17,.40);--bcv-wire-page-bd:#d43d2a;--bcv-wire-page-bg:#ffffff;--bcv-wire-page-head:rgba(17,17,17,.05);
    --bcv-wire-page-head-bd:rgba(17,17,17,.22);--bcv-wire-section-bd:#98978f;--bcv-wire-section-bg:#fafafa;--bcv-wire-component-bd:#b0b0aa;--bcv-wire-component-bg:#fcfcfc;--bcv-wire-nav-bd:#141414;
    --bcv-wire-nav-bg:#f2f2f0;--bcv-wire-title-fg:#141414;--bcv-wire-sum-fg:#5c5c58;--bcv-wire-foot-fg:#5c5c58;--bcv-wire-url-bg:rgba(17,17,17,.05);--bcv-wire-bg:#ffffff;--bcv-flow-main:#2f7d32;--bcv-pgmain-ring:rgba(212,61,42,.60);
    --bcv-pgmain-glow:rgba(212,61,42,.16);--bcv-dot-idle:#b5b3ad;--bcv-dot-ok:#2f7d32;--bcv-dot-warn:#b26a00;--bcv-dot-bad:#c62828;--bcv-port-bd:#ffffff;
    --bcv-file-fg:#5c5c58;--bcv-page-1-bg:#fbfbfa;--bcv-page-2-bg:#f7faf7;--bcv-page-3-bg:#f6f9fc;--bcv-page-4-bg:#faf6f9;--bcv-page-5-bg:#fbf7f6;
    --bcv-doc-root-bg1:rgba(255,255,255,.97);--bcv-doc-root-bg2:rgba(246,246,244,.97);--bcv-doc-root-bd:rgba(17,17,17,.40);--bcv-doc-root-tag-fg:#ffffff;--bcv-doc-root-tag-bg:#141414;
    --bcv-doc-root-title:#141414;--bcv-doc-root-sum:#5c5c58;--bcv-doc-ch-h:#141414;--bcv-doc-ch-hb-fg:#ffffff;--bcv-doc-ch-hb-bg:#141414;--bcv-doc-ch-n:#5c5c58;--bcv-doc-ch-sum:#5c5c58;
    --bcv-doc-page-bg:rgba(255,255,255,.96);--bcv-doc-page-bd:rgba(17,17,17,.30);--bcv-doc-pg-h:#141414;--bcv-doc-pg-hb:#d43d2a;--bcv-doc-pg-hb-bd:rgba(212,61,42,.35);--bcv-doc-pg-sum:#5c5c58;
    --bcv-doc-shadow:rgba(20,20,20,.10);--bcv-doc-shadow-soft:rgba(20,20,20,.08);
    --bcv-file-name-fg:#12457C;--bcv-file-name-bg:rgba(31,95,160,.10);--bcv-file-name-bd:rgba(31,95,160,.40);
    --bcv-file-foot-fg:#2E5473;--bcv-file-sep-fg:#4E6273;--bcv-file-more-fg:#3F5768;
    --bcv-chg-add-fg:#1E5C3E;--bcv-chg-add-bg:rgba(47,125,50,.16);--bcv-chg-modify-fg:#7A4E0E;--bcv-chg-modify-bg:rgba(168,99,47,.18);
    --bcv-chg-delete-fg:#8E1F2E;--bcv-chg-delete-bg:rgba(212,61,42,.14);--bcv-chg-keep-fg:#55554f;--bcv-chg-keep-bg:rgba(31,95,160,.10)}

  body.theme-ink button{box-shadow:none!important}
  body.theme-ink .brand-dot,body.theme-ink .uid-box .uid-kicker::before{border-radius:0;box-shadow:none}
  body.theme-ink .uid-box,body.theme-ink .ui-sel-pop{box-shadow:0 12px 40px rgba(20,20,20,.18)}
 /* 主题切换器(设置-外观「界面主题」):色板卡形态,即时生效+持久化 */
  .seg.theme-seg{flex-wrap:wrap;gap:6px;border:none;border-radius:0;overflow:visible;flex:1 1 auto;min-width:0;flex-shrink:1}
  .seg.theme-seg button{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border-soft);border-radius:9px;
    background:var(--hover-bg);padding:5px 12px 5px 8px;font-size:11px;color:var(--muted);letter-spacing:1px}
  .seg.theme-seg button:hover{border-color:var(--bronze);color:var(--text)}
  .seg.theme-seg button.on{border-color:var(--bronze);color:var(--accent-bright);background:var(--accent-soft);
    box-shadow:0 0 0 1px var(--accent-soft)}
  .seg.theme-seg .sw{width:14px;height:14px;border-radius:4px;flex-shrink:0;display:inline-block}

 /* 白板可读性修复:Super Agent 指挥台(#sc-root)只在 board 视图退场并释放右侧预留
 (pp-wiki-tab 已有同款先例;实测 1440 视口下白板画布 330px→满宽,29% 缩放不可读根治)。
 收窄到 board 视图的原因:全局隐藏会让指挥台盖住项目/档案视图的右侧可点项(board.spec arc 点击实测确认) */
  body[data-view="board"] #sc-root{display:none}
  body[data-view="board"] .page{padding-right:28px}
  button{font-family:var(--sans);cursor:pointer}
 *{scrollbar-width:thin;scrollbar-color:var(--scrollbar) transparent}
 *:-webkit-scrollbar{width:5px}
 *:-webkit-scrollbar-thumb{background:var(--scrollbar);border-radius:3px}

 /* ===== 左侧栏(复刻 ZCode WorkspaceSidebar) ===== */
  #sidebar{position:fixed;left:0;top:0;bottom:0;width:var(--sbw);z-index:6;display:flex;flex-direction:column;
           background:rgba(10,7,5,.82);backdrop-filter:blur(10px);transition:transform .18s ease}
  #sidebar.hidden{transform:translateX(-100%)}
 /* 底部导航条常驻(#sb-user 不被它压住);画布形态下端导航条仍在,但侧栏已是浮动托盘 → 不预留 */
  body:not(.cv-shell) #sidebar{padding-bottom:var(--bnav-h)}
  #sbDrag{position:fixed;left:calc(var(--sbw) - 2px);top:0;bottom:0;width:5px;z-index:7;cursor:col-resize}
  body.sb-hidden #sbDrag{display:none}
  #sbDrag:hover{background:var(--accent-soft)}
  .sb-brand{display:flex;align-items:center;gap:9px;padding:16px 16px 12px;flex-shrink:0}
  .brand-dot{width:9px;height:9px;border-radius:50%;background:var(--bronze);box-shadow:0 0 10px var(--bronze-glow)}
  .sb-brand .bn{font-family:var(--serif);font-size:14px;letter-spacing:4px;color:var(--brand)}
  .sb-brand .bs{margin-left:auto;font-size:9px;letter-spacing:2px;color:var(--faint);text-transform:uppercase}
 /* 画布/经典形态切换常驻入口:两种形态常驻(画布模式下点它回经典,与 composer 药丸/HUD「经典」同语义) */
  .sb-mode-btn{display:flex;align-items:center;gap:8px;margin:0 12px 10px;padding:6px 10px;flex-shrink:0;
               border:1px solid var(--border-soft);border-radius:8px;background:rgba(201,143,69,.06);
               color:var(--muted);font-size:11px;cursor:pointer;font-family:inherit;text-align:left;transition:.15s}
  .sb-mode-btn:hover{color:var(--text);border-color:var(--bronze);background:rgba(201,143,69,.13)}
  .sb-mode-btn .ic{color:var(--bronze);font-size:13px;line-height:1}
  .sb-mode-btn .kbd{margin-left:auto;font-size:9px;color:var(--faint);font-family:var(--mono);letter-spacing:0}
 /* ===== 底部导航条(§ 导航下移):原左栏 .sb-acts 整块物理搬到 </aside> 之后的 body 直属节点;
 * 横跨整窗 fixed 贴底,常驻(Ctrl+B 折叠侧栏不影响它),18 项放不下横向滚动;
 * 注:#sidebar 有 backdrop-filter,其子元素 fixed 不相对视口 → 必须搬 DOM,纯 CSS 无效。 */
  .sb-acts{position:fixed;left:0;right:0;bottom:0;z-index:10;display:flex;flex-direction:row;align-items:center;
           gap:2px;padding:0 8px;height:var(--bnav-h);flex-shrink:0;
           background:rgba(10,7,5,.86);border-top:1px solid var(--border-soft);backdrop-filter:blur(8px);
           overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
  .sb-acts::-webkit-scrollbar{display:none}
  .sb-acts .sb-act{flex:0 0 auto;white-space:nowrap;padding:6px 9px;gap:7px}
  .sb-acts .sb-kbd{display:none} /* 底部条省宽:快捷键徽标不占位 */
  .sb-act{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;font-size:12.5px;
          color:var(--muted);cursor:pointer;user-select:none;transition:.15s}
  .sb-act:hover{background:var(--hover-bg);color:var(--text)}
  .sb-act.on{background:rgba(201,143,69,.12);color:var(--accent-bright)}
  .sb-act svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
  .sb-kbd{margin-left:auto;font-size:9px;color:var(--faint);border:1px solid var(--border-soft);border-radius:4px;padding:1px 5px}
 /* nav-to-sidebar(用户):「新建任务/指挥台/RSI 看板」三入口从底部条迁回左侧栏顶部块;
 * markup 沿用 .sb-act 原样(id 不变 → onclick/点亮逻辑零改);窄屏随侧栏塌折成 64px 图标条,不另做悬浮。 */
  .sb-nav{display:flex;flex-direction:column;gap:2px;margin:2px 8px 4px;flex-shrink:0}
  .sb-sep{height:1px;background:var(--border-soft);margin:10px 16px;flex-shrink:0}
 /* ---- 画布形态:侧栏托盘承接导航(双导航融合,cvRail 窄定位栏退役)----
 * · .cv-card-off:对应画布卡片被隐藏 → 托盘按钮置灰(点击仍可点,switchView 分流会唤回+聚焦);
 * · .cv-bad/.cv-warn:卡片状态点(待审批/Git 变更/运行中)同款落到按钮右上角;
 * · .cv-conn-*:连接点(header 画布形态隐藏)落到托盘品牌点;
 * · .cv-tray-min:托盘自带最小化钮(收起为既有 #sbRail 细条,Ctrl+B/细轨 logo 唤回)。 */
  body.cv-shell .sb-act{position:relative}
  body.cv-shell .sb-act.cv-card-off{opacity:.45}
  body.cv-shell .sb-act.cv-bad::after,body.cv-shell .sb-act.cv-warn::after{content:'';position:absolute;right:8px;top:8px;
    width:5px;height:5px;border-radius:50%}
  body.cv-shell .sb-act.cv-bad::after{background:var(--red,#e08a7a);box-shadow:0 0 6px rgba(224,138,122,.7)}
  body.cv-shell .sb-act.cv-warn::after{background:var(--warn,#d9b36c)}
  body.cv-shell #sidebar.cv-conn-ok .brand-dot{background:var(--bronze);box-shadow:0 0 10px var(--bronze-glow)}
  body.cv-shell #sidebar.cv-conn-bad .brand-dot{background:var(--red,#e08a7a);animation:blink 1.4s infinite}
  .cv-tray-min{display:none}
  body.cv-shell .cv-tray-min{display:flex;position:absolute;top:8px;right:8px;z-index:4;width:20px;height:20px;
    align-items:center;justify-content:center;border:1px solid var(--border-soft);border-radius:6px;background:transparent;
    color:var(--faint);font-size:11px;line-height:1;cursor:pointer;padding:0}
  body.cv-shell .cv-tray-min:hover{color:var(--text);border-color:var(--bronze)}
 /* ---- 子agent会话流卡(分身消息独立看板;画布形态专属,经典布局整体隐藏)----
 * 正文块直接复用 Chat 卡渲染器(replyBlockHtml → .task-reply/.reply-wrap:同款转轮折叠/折行/展开全文)。 */
  body:not(.cv-shell) #view-subchat{display:none}
  body:not(.cv-shell) #act-subchat{display:none}
  .sm-h{font-family:var(--mono);font-size:10px;letter-spacing:1px;color:var(--faint);margin:4px 0 6px}
 /* 选中式消息流:左=子代理选择器(运行中/已结束两区),右=选中者消息流(形态对齐主 chat)。 */
  #subchat-body{display:flex;flex:1;min-height:0;overflow:hidden}
  #subchat-list{width:clamp(180px,24%,260px);flex-shrink:0;overflow-y:auto;overflow-x:hidden;
    border-right:1px solid var(--border-soft);padding:4px 8px;display:flex;flex-direction:column;gap:3px}
  #subchat-pane{flex:1;min-width:0;overflow-y:auto;padding:6px 12px 20px;display:flex;flex-direction:column;gap:8px}
  .sm-sec{font-family:var(--mono);font-size:9px;letter-spacing:1.5px;color:var(--faint);margin:8px 0 3px}
  .sl-item{display:flex;flex-direction:column;align-items:stretch;gap:2px;border:1px solid transparent;border-radius:8px;padding:4px 8px;
    cursor:pointer;font-size:11px;color:var(--muted);font-family:var(--mono);min-width:0;user-select:none}
  .sl-item:hover{color:var(--text);background:var(--hover-bg)}
  .sl-item.on{color:var(--bronze);border-color:var(--bronze-dim);background:rgba(201,143,69,.08)}
  .sl-item .sl-main{display:flex;align-items:center;gap:6px;min-width:0}
  .sl-item .sl-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sl-item .sl-role{color:var(--bronze);flex-shrink:0;font-size:9px}
  .sl-item .sl-n{margin-left:auto;flex-shrink:0;font-family:var(--mono);font-size:9px;color:var(--faint)}
 /* n3 融合(原分身 Agents 卡独有信息):模型/会话短码/失败原因 元信息行 + 终态文本「详情」折叠 */
  .sl-item .sl-meta{font-family:var(--mono);font-size:9px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:14px}
  .sl-item .sl-reap{color:#e08a7a}
  .sl-item .sl-final{font-family:var(--mono);font-size:9px;color:var(--faint);padding-left:14px}
  .sl-item .sl-final summary{cursor:pointer;list-style:none;color:var(--bronze-dim)}
  .sl-item .sl-final summary::before{content:"▸ "}
  .sl-item .sl-final[open] summary::before{content:"▾ "}
  .sl-item .sl-final-tx{white-space:pre-wrap;overflow-wrap:anywhere;max-height:120px;overflow-y:auto;color:var(--muted);
    border:1px dashed var(--border-soft);border-radius:6px;padding:3px 5px;margin-top:2px;background:rgba(0,0,0,.22)}
 /* 终态全文钮:左栏只放摘要,全文去右侧消息流看(左栏窄,不铺 markdown) */
  .sl-item .sl-final-more{cursor:pointer;margin-top:3px;background:transparent;border:1px solid var(--bronze-dim);
    border-radius:6px;color:var(--bronze);font-family:var(--mono);font-size:9px;padding:1px 6px}
  .sl-badge{margin-left:auto;flex-shrink:0;font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--accent-bright);
    border:1px solid var(--bronze);border-radius:8px;padding:0 6px}
  .sm-task{font-size:10.5px;color:var(--faint);white-space:pre-wrap;overflow-wrap:anywhere;max-height:110px;overflow-y:auto}
  .sm-msg{display:flex;flex-direction:column;gap:1px;border-left:2px solid var(--border-soft);padding-left:8px}
  .sm-time{font-family:var(--mono);font-size:9px;color:var(--faint)}
  .sm-final{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:pre-wrap;word-break:break-word;
    border:1px dashed var(--border-soft);border-radius:8px;padding:6px 8px;margin-top:2px}
 /* 终态卡 markdown(超长折叠):mdToHtml 产物在窄 pane 里走正常排版 */
  .sm-final .sm-final-md{white-space:normal;font-family:var(--sans)}
  .sm-final .sm-final-md>p{margin:2px 0}
  .sm-final>details>summary{cursor:pointer;list-style:none;color:var(--bronze-dim);font-size:9.5px}
  .sm-final>details>summary::before{content:"▸ "}
  .sm-final>details[open]>summary::before{content:"▾ "}
  .sp-empty{margin:auto;font-size:11px;color:var(--faint);font-family:var(--mono);text-align:center;padding:24px 8px}
  .sp-dispatch{border:1px solid var(--border-soft);border-radius:10px;background:var(--glass);padding:8px 12px;
    display:flex;flex-direction:column;gap:4px}
  .sp-dispatch .sp-dh{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text)}
  .sp-dispatch .sp-dmeta{font-family:var(--mono);font-size:9.5px;color:var(--faint);display:flex;gap:10px;flex-wrap:wrap}
  .sp-dispatch .sp-dtask{max-height:200px;overflow-y:auto;color:var(--text);font-size:11px;white-space:pre-wrap;
    word-break:break-word;border:1px solid var(--border-soft);border-radius:7px;padding:6px 8px;background:rgba(0,0,0,.25);font-family:var(--sans)}
 /* 任务书 markdown + 折叠(短任务书默认展开,长任务书收起;摘要行=首行提要) */
  .sp-dispatch .sp-dtask[open]{max-height:380px}
  .sp-dispatch .sp-dtask>summary{cursor:pointer;list-style:none;font-family:var(--mono);font-size:9.5px;color:var(--bronze-dim);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sp-dispatch .sp-dtask>summary::before{content:"▸ "}
  .sp-dispatch .sp-dtask[open]>summary::before{content:"▾ "}
  .sp-dispatch .sp-dtask .sp-dtask-md{white-space:normal;max-height:330px;overflow-y:auto}
  .sp-note{font-size:10.5px;color:var(--faint);font-family:var(--mono);padding:2px 4px 8px}
  .sp-dispatch .sp-dst{margin-left:auto;font-family:var(--mono);font-size:9.5px;color:var(--faint);flex-shrink:0}
  .sp-dispatch .sp-dst.run{color:var(--warn)} .sp-dispatch .sp-dst.ok{color:var(--green)} .sp-dispatch .sp-dst.fail{color:var(--red)}
  .sl-empty{font-size:10.5px;color:var(--faint);font-family:var(--mono);padding:10px 6px}
  .sl-item .sd-dot,.sp-dispatch .sd-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .sl-item .sd-dot.run,.sp-dispatch .sd-dot.run{background:var(--warn);animation:stpulse 1.2s infinite}
  .sl-item .sd-dot.ok,.sp-dispatch .sd-dot.ok{background:var(--green)} .sl-item .sd-dot.fail,.sp-dispatch .sd-dot.fail{background:var(--red)}
  .sl-item .sd-dot.end,.sp-dispatch .sd-dot.end{background:var(--faint)}
  .sm-loc{animation:smFlash 1.2s ease}
  @keyframes smFlash{0%{box-shadow:0 0 0 3px var(--bronze-glow)}100%{box-shadow:0 0 0 0 transparent}}
  .sb-toolbar{display:flex;align-items:center;gap:2px;padding:2px 8px 6px;flex-shrink:0}
  .sb-tt{font-size:10.5px;color:var(--faint);padding:3px 6px;border-radius:6px;cursor:pointer;white-space:nowrap}
  .sb-tt:hover{color:var(--muted)}
  .sb-tt.on{color:var(--text);background:var(--hover-bg2)}
  .sb-proj{display:flex;align-items:center;gap:8px;padding:6px 16px;font-size:12px;color:var(--text);
           cursor:pointer;user-select:none;flex-shrink:0;border-radius:6px;margin:0 8px}
  .sb-proj:hover{background:var(--hover-bg)}
  .sb-proj svg{width:14px;height:14px;stroke:var(--bronze);fill:none;stroke-width:1.8;stroke-linecap:round}
  .sb-proj .cnt{margin-left:auto;font-size:10px;color:var(--faint)}
  #taskList{flex:1;overflow-y:auto;padding:2px 8px 8px;min-height:0}
 /* ---- 侧栏折叠细轨 + workspace 行为深拷贝(ZCode WorkspaceSidebar 逻辑移植) ---- */
  #sidebar{transition:transform .2s ease-out,opacity .2s ease-out}
  body.sb-resizing #sidebar{transition:none}
  #sbRail{position:fixed;left:0;top:0;bottom:0;width:44px;z-index:30;display:none;flex-direction:column;align-items:center;gap:6px;padding-top:12px;border-right:1px solid var(--border-soft);background:var(--window-bg,#141009)}
  body.sb-hidden #sbRail{display:flex}
  .rail-btn{width:30px;height:30px;border-radius:8px;border:0;background:transparent;color:var(--faint);cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
  .rail-btn:hover{background:var(--hover-bg2);color:var(--text)}
  .rail-btn .r-a{transition:opacity .15s;font-family:var(--serif);font-size:13px;color:var(--brand)}
  .rail-btn svg{position:absolute;inset:0;margin:auto;width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;opacity:0;transition:opacity .15s}
  .rail-btn:hover .r-a{opacity:0}
  .rail-btn:hover svg{opacity:1}
 /* 桶头(PurposeSection/workspace 行):chevron 与把手 hover 才显;行内动作 hover 才挂(ZCode 同款) */
  .t-bh .bh-chev{opacity:0;transition:opacity .15s}
  .t-bh:hover .bh-chev,.t-bh:focus-within .bh-chev{opacity:1}
  @media (hover:none){.t-bh .bh-chev{opacity:1}}
  .bh-grip{width:8px;height:14px;flex:none;cursor:grab;background:radial-gradient(circle,var(--faint) 1px,transparent 1.4px) 0 1px/4px 6px;opacity:0;transition:opacity .15s}
  .t-bh:hover .bh-grip{opacity:1}
  .bh-grip:active{cursor:grabbing}
  .bh-live{display:inline-flex;align-items:center;gap:4px;font-size:9px;color:var(--warn);letter-spacing:0}
  .bh-live i{width:6px;height:6px;border-radius:50%;background:var(--warn);animation:tnBreath 1.6s ease-in-out infinite}
  .bh-acts{display:none;align-items:center;gap:3px}
  .t-bh:hover .bh-acts{display:flex}
  .bh-new,.bh-more{font-size:10px;line-height:1;color:var(--faint);border:1px solid var(--border-soft);border-radius:6px;padding:2px 6px;cursor:pointer}
  .bh-new:hover,.bh-more:hover{color:var(--bronze);border-color:var(--bronze)}
  .bh-files,.bh-ide{display:inline-flex;align-items:center;font-size:10px;line-height:1;color:var(--faint);border:1px solid var(--border-soft);border-radius:6px;padding:2px 5px;cursor:pointer}
  .bh-files:hover,.bh-ide:hover{color:var(--bronze);border-color:var(--bronze)}
 /* ── #view-ide 编辑器视图(vscode 风格三栏:树/标签条/编辑区)。
 编辑区容器 .ide-edit 显式豁免严格交互禁选中(input-policy TEXT_SEL 引用该 id);
 树/标签条 chrome 面随面板既有 user-select 约束。全部新类走 .ide-* 前缀(与文件树 .ft-row 区隔)。 ── */
  .ide-shell{flex:1;display:flex;min-height:0;overflow:hidden}
  .ide-side{width:230px;min-width:150px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid var(--border-soft);overflow:hidden}
  .ide-side-h{display:flex;align-items:center;justify-content:space-between;padding:5px 8px 3px;font-size:9.5px;letter-spacing:1.2px;color:var(--faint);font-family:var(--mono);user-select:none}
  .ide-refresh{font-size:10px;line-height:1;color:var(--faint);border:1px solid var(--border-soft);border-radius:6px;padding:2px 6px;cursor:pointer;background:transparent}
  .ide-refresh:hover{color:var(--bronze);border-color:var(--bronze)}
  .ide-tree{flex:1;overflow:auto;padding:2px 4px 10px;font-size:12px;min-height:0}
  .ide-actbar{width:38px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;border-right:1px solid var(--border-soft);user-select:none}
  .ide-act{width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--faint);cursor:pointer;border-left:2px solid transparent;border-radius:4px}
  .ide-act:hover{color:var(--text)}
  .ide-act.on{color:var(--bronze);border-left-color:var(--bronze)}
  .ide-panel{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:4px}
  .ide-p-meta{font-size:9.5px;letter-spacing:1.2px;color:var(--faint);font-family:var(--mono);padding:2px 4px 4px}
  .ide-p-list{flex:1;overflow:auto;font-size:11.5px;min-height:0}
  .ide-p-row{display:flex;gap:6px;padding:2px 4px;cursor:pointer;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ide-p-row:hover{background:var(--hover-bg,var(--border-soft))}
  .ide-scm-label{font-family:var(--mono);flex-shrink:0}
  .ide-scm-M{color:var(--warn)} .ide-scm-A,.ide-scm-U{color:var(--green)} .ide-scm-D{color:var(--red)}
  #ideScmMsg{resize:vertical;min-height:34px;font-size:11.5px;margin:4px 0;padding:4px 6px}
  .ide-dg-err{color:var(--red)} .ide-dg-warn{color:var(--warn)}
  .ft-badge{flex-shrink:0;font-family:var(--mono);font-size:9px;color:var(--warn);align-self:center}
  .ide-term{height:190px;flex-shrink:0;display:flex;flex-direction:column;border-top:1px solid var(--border-soft);background:var(--bg-deep,transparent)}
  .ide-term-h{display:flex;align-items:center;justify-content:space-between;padding:3px 8px;font-size:9.5px;letter-spacing:1.2px;color:var(--faint);font-family:var(--mono)}
  #ideTermOut{flex:1;overflow:auto;margin:0;padding:4px 10px;font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;word-break:break-all;min-height:0}
  .ide-term-in-row{display:flex;gap:6px;padding:4px 8px;align-items:center;font-family:var(--mono);color:var(--green)}
  #ideTermIn{flex:1;font-family:var(--mono);font-size:11.5px}
  .ide-main{flex:1;display:flex;flex-direction:column;min-width:0;overflow:hidden}
  .ide-tabs{display:flex;align-items:center;gap:2px;overflow-x:auto;flex-shrink:0;border-bottom:1px solid var(--border-soft);padding:3px 4px 0;min-height:30px;user-select:none}
  .ide-tab{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;font-size:11.5px;color:var(--muted);border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;cursor:pointer;white-space:nowrap;flex-shrink:0}
  .ide-tab:hover{color:var(--text)}
  .ide-tab.on{color:var(--text);background:var(--accent-soft);border-color:var(--border-soft)}
  .ide-tab .dirty{color:var(--warn);font-size:9px}
  .ide-tab .x{display:inline-flex;width:15px;height:15px;align-items:center;justify-content:center;border-radius:4px;font-size:11px;color:var(--faint)}
  .ide-tab .x:hover{color:var(--red);background:rgba(255,255,255,.07)}
 /* J5 文件类型色(与图标形同步:同类型同色,深浅主题共用;--faint/--muted 走主题令牌) */
  .fic-ts{color:#4f9fe0}.fic-js{color:#e3c25a}.fic-py{color:#5aa9d6}.fic-json{color:#c9b04a}
  .fic-md{color:#8fa6c4}.fic-img{color:#b07ad6}.fic-data{color:#e08a5a}.fic-bin{color:var(--faint)}
  .fic-sh{color:#6fbf7f}.fic-git{color:#d8794a}.fic-lock{color:var(--muted)}.fic-txt{color:var(--faint)}
  .ide-tab .tab-ic{display:inline-flex;width:13px;height:13px;flex-shrink:0}
  .ide-tab .tab-ic .icn{width:13px;height:13px}
  .ft-row .ic .icn,.ide-tab .tab-ic .icn{flex-shrink:0}
  .ide-body{flex:1;display:flex;flex-direction:column;min-height:0;position:relative}
  .ide-edit{flex:1;width:100%;min-height:0;margin:0;padding:8px 10px;border:none;outline:none;resize:none;background:transparent;color:var(--text);font-family:var(--mono);font-size:var(--fs-code);line-height:var(--lh-code);tab-size:4}
  .ide-edit:focus{outline:none}
 /* C:Monaco 挂载容器(与 .ide-edit 同布局位;高度由 monaco.editor.create 自管) */
  .ide-monaco{flex:1;width:100%;min-height:0;position:relative;overflow:hidden}
  .ide-monaco .monaco-editor{font-family:var(--mono)!important}
 /* Markdown 预览层(与 #ideMonacoHost 同布局位;预览时 Monaco 只 display:none,不卸载模型) */
  .ide-md{flex:1;width:100%;min-height:0;overflow:auto;padding:20px 26px;user-select:text;color:var(--text);
    line-height:var(--lh-body);letter-spacing:var(--ls-body);font-size:var(--fs-body-sm)}
  .ide-preview{flex:1;width:100%;min-height:0;background:#fff}
  .ide-preview iframe{width:100%;height:100%;border:0;display:block}
 /* 阅读密度:.ide-md 标题层级靠「上间距 + 分隔线 + 字号差」三件套区分,
 段落/列表/表格统一放大块距;表格改由 .md-table-wrap 横向滚动,不再压列宽。 */
  .ide-md h1,.ide-md h2,.ide-md h3,.ide-md h4,.ide-md h5,.ide-md h6{font-family:var(--sans);color:var(--brand);margin:var(--gap-head) 0 calc(var(--gap-block) / 2);line-height:var(--lh-tight)}
  .ide-md h1,.ide-md h2{font-size:1.5em;font-weight:600;padding-bottom:6px;border-bottom:1px solid var(--border-soft)}
  .ide-md h1:first-child,.ide-md h2:first-child,.ide-md h3:first-child{margin-top:4px}
  .ide-md h3{font-size:1.22em;font-weight:600;padding-left:10px;border-left:3px solid var(--bronze)}
  .ide-md h4{font-size:1.08em;font-weight:600;padding-left:8px;border-left:2px solid color-mix(in srgb,var(--bronze) 55%,transparent)}
  .ide-md h5,.ide-md h6{font-size:1em;font-weight:600;color:var(--muted);letter-spacing:var(--ls-cjk)}
  .ide-md p{margin:var(--gap-block) 0}
  .ide-md ul,.ide-md ol{margin:var(--gap-block) 0 var(--gap-block) var(--indent-1);padding-left:0}
  .ide-md li>ul,.ide-md li>ol{margin-left:var(--indent-1)}
  .ide-md li>ul li>ul,.ide-md li>ol li>ol{margin-left:var(--indent-1)}
  .ide-md li{margin:var(--gap-tool) 0}
  .ide-md li>p{margin:4px 0}
  .ide-md a{color:var(--bronze);text-decoration:none;border-bottom:1px dashed color-mix(in srgb,var(--bronze) 55%,transparent)}
  .ide-md a:hover{color:var(--accent-bright)}
  .ide-md code{font-family:var(--mono);font-size:.92em;background:var(--code-bg);border-radius:4px;padding:1px 5px;letter-spacing:var(--ls-code)}
  .ide-md .code-wrap{margin:var(--gap-block) 0}
  .ide-md .code-wrap.is-code{background:var(--code-bg)}
  .ide-md pre{border:1px solid var(--border-soft);border-radius:9px;background:var(--code-bg);color:var(--text);
    padding:12px 14px;overflow:auto;margin:var(--gap-block) 0;font-family:var(--mono);font-size:var(--fs-code);line-height:var(--lh-code);letter-spacing:var(--ls-code)}
  .ide-md .code-wrap pre.code{padding:10px 14px;font-size:var(--fs-code);line-height:var(--lh-code);border:none;background:transparent;border-radius:0}
  .ide-md table{border-collapse:collapse;margin:var(--gap-block) 0;font-size:var(--fs-body-sm);line-height:var(--lh-tight)}
  .ide-md .md-table-wrap{margin:var(--gap-block) 0;border:1px solid var(--border-soft);border-radius:8px}
  .ide-md .md-table-wrap>table{margin:0}
  .ide-md th,.ide-md td,.ide-md .md-table th,.ide-md .md-table td{border:1px solid var(--border-soft);padding:9px 13px;text-align:left;vertical-align:top}
  .ide-md th,.ide-md .md-table th{background:var(--hover-bg);color:var(--text);font-weight:600;white-space:nowrap}
  .ide-md tbody tr:nth-child(even),.ide-md .md-table tbody tr:nth-child(even){background:rgba(201,143,69,.055)}
  .ide-md tbody tr:hover,.ide-md .md-table tbody tr:hover{background:rgba(201,143,69,.11)}
  .ide-md blockquote{margin:var(--gap-block) 0;padding:8px 14px;border-left:3px solid color-mix(in srgb,var(--bronze) 55%,transparent);
    background:var(--hover-bg);border-radius:0 7px 7px 0;color:var(--muted)}
  .ide-md img.md-img{display:block;max-width:100%;margin:10px 0;border-radius:10px;border:1px solid var(--border-soft);background:#fff}
  .ide-md video.md-video{display:block;max-width:100%;max-height:60vh;margin:10px 0;border-radius:10px;border:1px solid var(--border-soft);background:#000}
  .ide-md a.md-link{color:var(--brand);text-decoration:underline;cursor:pointer}
  .ide-md hr,.ide-md .md-hr{border:none;height:1px;margin:var(--gap-block) 0;background:linear-gradient(90deg,color-mix(in srgb,var(--bronze) 45%,transparent),transparent)}
  .ide-ro{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px;color:var(--faint);font-size:12.5px;padding:18px;text-align:center}
  .ide-welcome{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--faint);font-size:13px;text-align:center;padding:24px}
 /* IDE 图片预览层(第五层):下沉底 + 缩放/平移查看器(滚轮缩放、拖动平移、双击 适应↔1:1) */
  .ide-img{flex:1;min-height:0;position:relative;display:flex;background:var(--sunken)}
  .ide-img-scroll{position:absolute;inset:0;overflow:auto;padding:16px;overscroll-behavior:contain}
  .ide-img-stage{display:flex;align-items:center;justify-content:center;width:max-content;height:max-content;min-width:100%;min-height:100%}
  .ide-img img{display:block;max-width:none;max-height:none;image-rendering:auto;background:repeating-conic-gradient(rgba(255,255,255,.05) 0% 25%,transparent 0% 50%) 0 0/16px 16px}
  .ide-img.zoomed .ide-img-scroll{cursor:grab}
  .ide-img.dragging .ide-img-scroll{cursor:grabbing}
  .ide-img.dragging img{pointer-events:none}
 /* 控件盖在任意图片上:固定深底浅字(不随明暗主题/图片底色变化),保证对比度 */
  .ide-img-bar{position:absolute;top:8px;right:8px;z-index:3;display:flex;align-items:center;gap:4px;padding:3px 5px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:rgba(13,10,7,.78);box-shadow:0 4px 14px rgba(0,0,0,.35);backdrop-filter:blur(4px)}
  .ide-img-btn{min-width:22px;height:22px;padding:0 6px;border:1px solid rgba(255,255,255,.16);border-radius:5px;background:transparent;color:rgba(255,255,255,.88);cursor:pointer;font-size:12px;line-height:1;font-family:var(--mono)}
  .ide-img-btn:hover{color:#f0b25c;border-color:#f0b25c;background:rgba(255,255,255,.08)}
  .ide-img-pct{min-width:42px;text-align:center;font-size:10.5px;font-family:var(--mono);color:rgba(255,255,255,.72);cursor:pointer;user-select:none}
  .ide-img-pct:hover{color:#f0b25c}
 /* IDE 媒体层(第六层:<video>/<audio> 直连 /ide/asset;音频附频谱 canvas(点画布定位时间轴) */
  .ide-media{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px;background:var(--sunken);overflow:auto;overscroll-behavior:contain}
  .ide-media video{max-width:100%;max-height:100%;background:#000;border-radius:8px}
  .ide-media-audio{width:100%;max-width:760px;display:flex;flex-direction:column;gap:8px}
  .ide-media-audio audio{width:100%}
  .ide-media-bar{display:flex;align-items:center;gap:8px}
  .ide-media-hint{font-size:10.5px;color:var(--faint);font-family:var(--mono);user-select:none}
  .ide-media-spec{width:100%;height:140px;display:block;background:var(--sunken);border:1px solid var(--border-soft);border-radius:8px;cursor:crosshair}
  .ide-media-spec+.ide-media-hint{margin-top:-4px}
  .ide-office{flex:1;width:100%;min-height:0;overflow:auto;padding:12px;background:var(--sunken)}
 /* 板「OOXML 文本回写」P2:Office 预览上方工具条(编辑文本/保存/取消编辑) */
  .ide-office-wrap{flex:1;width:100%;min-height:0;display:flex;flex-direction:column}
  .ide-office-bar{flex-shrink:0;display:flex;align-items:center;gap:6px;padding:4px 10px;border-bottom:1px solid var(--border-soft);font:10.5px/1.6 var(--mono);color:var(--faint);user-select:none}
  .ide-office-bar .io-b{background:transparent;color:var(--faint);border:1px solid var(--border-soft);border-radius:6px;padding:1px 8px;font:inherit;cursor:pointer}
  .ide-office-bar .io-b:hover:not(:disabled){color:var(--bronze);border-color:var(--bronze)}
  .ide-office-bar .io-b:disabled{opacity:.45;cursor:default}
  .ide-office-bar .io-b.on{color:var(--bronze);border-color:var(--bronze)}
  .ide-office-bar .io-hint{margin-left:auto;opacity:.8}
  .ide-office-hint{color:var(--faint);font-size:12px;line-height:1.8;font-family:var(--mono);user-select:text}
  .ide-status{flex-shrink:0;display:flex;align-items:center;gap:10px;padding:3px 10px;font-size:10.5px;color:var(--faint);border-top:1px solid var(--border-soft);font-family:var(--mono);user-select:none}
 /* ---- IDE 深化(VSCode P0 编辑体验):面包屑/侧栏操作条/搜索面板/命令面板/状态条分段 ---- */
  .ide-side-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .ide-side-acts{display:flex;align-items:center;gap:3px;flex-shrink:0}
  .ide-side-btn{font-size:10px;line-height:1;color:var(--faint);border:1px solid var(--border-soft);border-radius:6px;padding:2px 5px;cursor:pointer;background:transparent;font-family:var(--mono);white-space:nowrap}
  .ide-side-btn:hover{color:var(--bronze);border-color:var(--bronze)}
  .ide-crumb{flex-shrink:0;display:flex;align-items:center;gap:2px;min-height:22px;padding:1px 8px;font-size:10.5px;color:var(--faint);border-bottom:1px solid var(--border-soft);overflow-x:auto;white-space:nowrap;font-family:var(--mono);user-select:none}
  .ide-crumb .cb-seg{cursor:pointer;border-radius:4px;padding:1px 4px;flex-shrink:0}
  .ide-crumb .cb-seg:hover{color:var(--bronze);background:rgba(201,143,69,.10)}
  .ide-crumb .cb-seg.last{color:var(--text);cursor:default}
  .ide-crumb .cb-seg.last:hover{color:var(--text);background:transparent}
  .ide-crumb .cb-sep{color:var(--border);flex-shrink:0}
  .ide-crumb .cb-right{margin-left:auto;display:flex;gap:9px;flex-shrink:0;color:var(--faint)}
  .ide-crumb .cb-right b{color:var(--muted);font-weight:400}
 /* 侧栏全局搜索面板(Ctrl+Shift+F;非模态,占侧栏上半) */
  .ide-find{display:none;flex-direction:column;gap:4px;padding:6px 7px 8px;border-bottom:1px solid var(--border-soft);flex-shrink:0;background:var(--sunken)}
  .ide-find.on{display:flex}
  .ide-find-h{display:flex;align-items:center;justify-content:space-between;font-size:9.5px;letter-spacing:1.1px;color:var(--faint);font-family:var(--mono)}
  .ide-find input[type=text]{width:100%;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:11.5px;padding:3px 7px;outline:none;font-family:var(--mono)}
  .ide-find input[type=text]:focus{border-color:var(--bronze)}
  .ide-find-row{display:flex;align-items:center;gap:8px;font-size:10px;color:var(--faint);font-family:var(--mono)}
  .ide-find-row label{display:flex;align-items:center;gap:3px;cursor:pointer}
  .ide-find-res{max-height:34vh;overflow:auto;display:flex;flex-direction:column;gap:1px}
  .ide-find-hit{padding:2px 5px;border-radius:5px;cursor:pointer;font-family:var(--mono);font-size:10.5px;color:var(--muted);line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ide-find-hit:hover{background:rgba(201,143,69,.12);color:var(--text)}
  .ide-find-hit .fh-loc{color:var(--bronze)}
  .ide-find-file{padding:3px 5px;font-size:10px;color:var(--faint);font-family:var(--mono);letter-spacing:.4px}
 /* 命令面板(IDE 专属 Ctrl+Shift+P;独立于 #cc,避免污染命令中心域判定) */
  #ideCmd{position:fixed;inset:0;z-index:22;display:none;background:var(--overlay);backdrop-filter:blur(2px)}
  #ideCmd.on{display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
  .ide-cmd-box{width:min(600px,84vw);background:#120c07;border:1px solid var(--bronze);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.66);overflow:hidden}
  .ide-cmd-box input{width:100%;border:none;border-bottom:1px solid var(--border-soft);background:transparent;color:var(--text);padding:13px 16px;font-size:13px;outline:none;font-family:var(--mono)}
  .ide-cmd-box input::placeholder{color:var(--faint)}
  #ideCmdList{max-height:46vh;overflow-y:auto;padding:6px}
  .ide-cmd-item{display:flex;align-items:center;gap:9px;padding:7px 11px;border-radius:8px;cursor:pointer}
  .ide-cmd-item:hover,.ide-cmd-item.hot{background:rgba(201,143,69,.12)}
  .ide-cmd-item .ci-t{flex:1;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ide-cmd-item.hot .ci-t{color:var(--text)}
  .ide-cmd-item .ci-k{font-family:var(--mono);font-size:9.5px;color:var(--faint);flex-shrink:0}
  .ide-cmd-item .ci-g{font-size:9px;color:var(--bronze);border:1px solid rgba(201,143,69,.35);border-radius:4px;padding:0 4px;flex-shrink:0}
  .ide-cmd-foot{display:flex;gap:12px;padding:5px 12px;border-top:1px solid var(--border-soft);font-size:9.5px;color:var(--faint);font-family:var(--mono)}
 /* 状态条分段(ideStatusSet;旧单文本 ideStatus 仍可用) */
  .ide-status .st{flex-shrink:0}
  .ide-status .st.dirty{color:var(--warn)}
  .ide-status .st.spacer{margin-left:auto}
 /* 全局搜索命中行高亮(ideRevealLine 全行装饰) */
  .ide-hit-line{background:rgba(201,143,69,.16)!important}
 /* 桶/分区拖拽(vertical-only,只位移不缩放) */
  #sbDragGhost{position:fixed;z-index:80;display:flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--bronze);border-radius:8px;background:var(--solid);box-shadow:0 8px 24px var(--overlay);font-size:11px;letter-spacing:1px;color:var(--text);pointer-events:none}
  .t-bh.dragging{opacity:.35}
  .t-bh.drop-before{box-shadow:inset 0 2px 0 var(--bronze)}
  .t-bh.drop-after{box-shadow:inset 0 -2px 0 var(--bronze)}
 /* purpose 分区头(项目/任务) */
  .sb-sec{padding:10px 8px 4px;font-size:10.5px;color:var(--muted);letter-spacing:2px}
 /* ---- 侧栏文件树滑入层(ZCode WorkspaceFileTree:桶头「文件树」打开,树层自右滑入盖住主区,底部用户行常驻) ---- */
  #sbFt{position:absolute;inset:0;z-index:12;display:flex;flex-direction:column;background:var(--window-bg,#141009);transform:translateX(-100%);visibility:hidden;transition:transform .2s ease-out,visibility .2s} /* 从左缘划出 */
  #sidebar.ft-open #sbFt{transform:none;visibility:visible}
  .sbft-head{display:flex;align-items:center;gap:8px;padding:14px 12px 8px;flex-shrink:0}
  .sbft-head .t{font-family:var(--serif);font-size:12px;letter-spacing:2px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sbft-btn{height:24px;border:1px solid var(--border-soft);border-radius:6px;background:transparent;color:var(--faint);cursor:pointer;font-size:11px;padding:0 8px;flex-shrink:0}
  .sbft-btn:hover{color:var(--bronze);border-color:var(--bronze)}
  #sbFtTree{flex:1;overflow-y:auto;padding:0 6px 10px;min-height:0}
  .t-row{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;border-radius:7px;cursor:pointer;user-select:none}
  .t-row:hover{background:var(--hover-bg)}
  .t-row.sel{background:rgba(201,143,69,.10);box-shadow:inset 2px 0 0 var(--bronze)}
  .t-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:rgba(255,255,255,.14)}
  .t-dot.running{background:transparent;border:1.5px solid var(--bronze);border-top-color:transparent;
                 animation:tSpin .8s linear infinite}
  @keyframes tSpin{to{transform:rotate(360deg)}}
  .t-dot.queued{background:var(--warn)}
  .t-dot.interrupted{background:transparent;border:1.5px dashed var(--warn)}
  .t-dot.failed,.t-dot.cancelled{background:var(--red)}
  .t-dot.done{background:rgba(157,192,139,.55)}
 /* 任务卡进度段(阶段/步/停滞):后端可选 progress 下发;缺失即整段不渲染(零变化) */
  .t-progress{flex:none;max-width:132px;font-size:10px;line-height:1.5;color:var(--faint);
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
  .t-progress.tp-warn{color:var(--warn)}
  .t-progress.tp-stall{color:var(--red)}
  .t-title{flex:1;font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5}
  .t-ct{flex:none;font-family:var(--mono);font-size:9px;color:var(--bronze);border:1px solid var(--border-soft);border-radius:999px;padding:0 5px}
  .t-row.sel .t-title{color:var(--text)}
  .t-ds{margin-left:auto;font-family:var(--mono);font-size:9px;display:inline-flex;gap:4px;flex-shrink:0}
  .t-ds .da{color:var(--green)}
  .t-ds .dd{color:var(--red)}
  .t-row .t-ds ~ .t-time{margin-left:0}
 /* grouped 视图吸顶组头(ZCode StickyGroupHeaderSlot) */
  #taskList.sticky-heads .t-bh{position:sticky;top:0;z-index:5;background:var(--window-bg,#141009);padding:6px 8px 3px}
 /* 拖拽中活动桶强制收起(ZCode resolveWorkspaceDragExpanded):拖拽起始逐行加 .dragging-hide */
  .dragging-hide{display:none!important}
 /* 归档行内动作(ZCode ArchivedTasksFlatSection:取消归档/删除) */
  .t-acts{display:none;align-items:center;gap:3px;flex-shrink:0}
  .t-row:hover .t-acts{display:inline-flex}
  @media (hover:none){.t-acts{display:inline-flex}}
  .ta-b{font-size:9.5px;color:var(--faint);border:1px solid var(--border-soft);border-radius:6px;padding:1px 6px;cursor:pointer}
  .ta-b:hover{color:var(--bronze);border-color:var(--bronze)}
  .ta-b.ta-del:hover{color:var(--red);border-color:var(--red)}
  .t-time{flex-shrink:0;font-size:9.5px;color:var(--faint)}
  .t-bucket{font-size:10px;color:var(--faint);letter-spacing:1px;padding:8px 8px 3px}
  .t-more{padding:4px 12px 6px 20px;font-size:10.5px;color:var(--faint);cursor:pointer;user-select:none}
  .t-more:hover{color:var(--muted)}
 /* 项目区(ZCode workspace 移植) */
  .proj-row{display:flex;align-items:center;gap:8px;padding:4px 16px;font-size:11.5px;color:var(--muted);cursor:pointer;border-left:2px solid transparent}
  .proj-row:hover{background:var(--hover-bg)}
  .proj-row.on{color:var(--text);border-left-color:var(--warn)}
  .proj-row .p-lab{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .proj-row .p-del{opacity:.4;cursor:pointer;font-size:11px}
  .proj-row .p-del:hover{opacity:1;color:var(--red)}
  .proj-row .p-un{font-size:10px;color:var(--red)}
  .sb-proj-add{display:flex;align-items:center;gap:8px;padding:4px 16px;font-size:11.5px;color:var(--muted);cursor:pointer}
  .sb-proj-add:hover{color:var(--text)}
  .sb-proj-add svg{width:13px;height:13px;stroke:currentColor;stroke-width:2;fill:none}
  #projAdd{padding:4px 16px 8px}
  #projPathInput{width:100%;background:var(--input-bg);border:1px solid var(--border-soft,rgba(255,255,255,.12));border-radius:6px;color:var(--text);font-size:11px;padding:5px 8px;font-family:var(--mono);outline:none}
  .proj-add-actions{display:flex;gap:6px;margin-top:5px}
  .proj-add-actions button{background:transparent;border:1px solid var(--border-soft,rgba(255,255,255,.15));color:var(--muted);border-radius:6px;font-size:11px;padding:2px 10px;cursor:pointer}
  .proj-add-actions button:hover{color:var(--text)}
  .sb-spacer{flex:0 0 auto;min-height:0}
  .sb-user{display:flex;align-items:center;gap:9px;padding:10px 14px 12px;border-top:1px solid var(--border-soft);flex-shrink:0;position:relative;z-index:13;background:var(--window-bg,#141009)}
  .u-ava{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--grad-a),var(--grad-b));
         color:var(--on-accent);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;
         flex-shrink:0;cursor:pointer}
  .u-name{font-size:11.5px;color:var(--text)}
  .u-sub{font-size:9px;color:var(--faint);margin-top:1px}
  .u-gear{margin-left:auto;cursor:pointer;padding:4px;border-radius:6px}
  .u-gear:hover{background:var(--hover-bg2)}
  .u-gear.on{background:rgba(201,143,69,.12)}
  .u-gear svg{width:14px;height:14px;stroke:var(--muted);fill:none;stroke-width:1.8;stroke-linecap:round;display:block}
  .u-gear.on svg{stroke:var(--accent-bright)}
 /* 版本更新提示:侧栏底部常驻,发现新版本才出现;强制更新(minVersion)时不可忽略 */
  .sb-update{margin:0 10px 8px;padding:9px 10px;border:1px solid var(--border-soft);border-radius:9px;
    background:linear-gradient(180deg,rgba(201,143,69,.13),rgba(201,143,69,.05));flex-shrink:0;position:relative;z-index:13}
  .sb-update .up-head{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text)}
  .sb-update .up-dot{width:6px;height:6px;border-radius:50%;background:var(--accent-bright,#e0b96a);box-shadow:0 0 8px var(--bronze-glow,rgba(201,143,69,.5))}
  .sb-update .up-close{margin-left:auto;border:0;background:transparent;color:var(--faint);font-size:13px;line-height:1;cursor:pointer;padding:0 2px}
  .sb-update .up-close:hover{color:var(--text)}
  .sb-update .up-sub{font-size:10px;color:var(--muted);line-height:1.45;margin-top:4px;max-height:42px;overflow:hidden}
  .sb-update .up-acts{display:flex;align-items:center;gap:6px;margin-top:7px}
  .sb-update .up-go{flex:1;border:1px solid rgba(201,143,69,.5);background:rgba(201,143,69,.16);color:var(--accent-bright,#e0b96a);
    border-radius:6px;font-size:11px;padding:4px 8px;cursor:pointer}
  .sb-update .up-go:hover{background:rgba(201,143,69,.26)}
  .sb-update .up-go[disabled]{opacity:.65;cursor:default}
  .sb-update .up-link{border:0;background:transparent;color:var(--muted);font-size:10.5px;cursor:pointer;padding:2px 4px}
  .sb-update .up-link:hover{color:var(--text)}
  body.sb-hidden .sb-update{display:none!important}
 /* 画布模式:经典侧栏整体收起(只剩细轨),更新横幅必须另有一个可见载体,
 否则新用户默认画布形态下永远看不到「有新版本」。浮层只在 body.cv-shell 且 .on 时出现。 */
  #updateFloat{position:fixed;right:18px;bottom:74px;width:286px;z-index:60;display:none;margin:0;
    background:var(--window-bg,#141009);box-shadow:0 10px 30px rgba(0,0,0,.38)}
  body.cv-shell #updateFloat.on,body.sb-hidden #updateFloat.on{display:block}

  .page{position:relative;z-index:1;display:flex;flex-direction:column;height:100%;
        padding-left:calc(var(--sbw) + 8px);padding-right:28px;padding-bottom:var(--bnav-h)}
  body.sb-hidden .page{padding-left:60px} /* 44px 细轨 + 16px(ZCode 折叠态仍有轨) */
  header{display:flex;align-items:center;padding:20px 28px 0;flex-shrink:0;gap:12px}
  .sb-toggle{width:28px;height:28px;border-radius:7px;border:none;background:transparent;display:flex;
             align-items:center;justify-content:center;cursor:pointer}
  .sb-toggle:hover{background:var(--hover-bg2)}
  .sb-toggle svg{width:15px;height:15px;stroke:var(--muted);fill:none;stroke-width:1.8;stroke-linecap:round}
  .brand{display:flex;align-items:center;gap:10px}
  .brand-name{font-family:var(--serif);font-size:15px;letter-spacing:5px;color:var(--brand)}
  .brand-sub{font-size:10px;letter-spacing:3px;color:var(--faint);text-transform:uppercase;margin-left:2px}
  .view-name{font-family:var(--serif);font-size:13px;letter-spacing:3px;color:var(--bronze);
             padding:3px 12px;border:1px solid var(--border-soft);border-radius:12px;display:none}
  body:not([data-view="chat"]) .view-name{display:inline-block}
  .top-right{margin-left:auto;display:flex;align-items:center;gap:10px}
  .pill{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);
        padding:5px 12px;border:1px solid var(--border-soft);border-radius:16px;background:var(--glass)}
  .pill .d{width:7px;height:7px;border-radius:50%;background:var(--faint)}
  .pill.on .d{background:var(--bronze);box-shadow:0 0 8px var(--bronze-glow)}

  .middle{flex:1;display:flex;min-height:0;align-items:stretch}
  .view{flex:1;display:none;flex-direction:column;min-width:0;overflow-y:auto}
  .view.on{display:flex}
 /* ── 双中心布局:会话流+IDE 并列常驻;DOM 零移动,仅 body.dual-center 态生效 ── */
  #dualSplit{display:none;flex:0 0 6px;width:6px;cursor:col-resize;border-radius:3px;background:transparent;transition:background .15s}
  #dualSplit:hover,#dualSplit.drag{background:var(--accent-soft)}
 /* 只在「会话流」视图显示分隔条:切到 board 等全屏视图时 dual 类仍挂着,不能让 6px 条留在画面上 */
  body.dual-center[data-view="chat"] #dualSplit{display:block}
  body.dual-center #view-tasks.on{flex:0 0 var(--dual-chatw,520px);min-width:0;padding-right:4px}
  body.dual-center #view-ide.on{flex:1 1 auto;min-width:280px;overflow:hidden;padding:14px 8px 14px 0}
 /* 右栏窄时自动让出侧栏(ide-side 固定 230px,280px 极限下会把编辑区压到 4px):
 container query 按右栏自身宽度裁决,不影响经典全屏 IDE。 */
  body.dual-center #view-ide{container-type:inline-size}
  @container (max-width: 560px){ #ideSide{display:none} #ideFind{display:none} }
  body.dual-center #sc-root{display:none}
  body.dual-center .page{padding-right:28px}
 /* 窄屏降级:≤1400 默认收窄栏宽;≤1150 禁双栏(右栏让位,IDE 走经典互斥全屏) */
  @media (max-width:1400px){ body.dual-center #view-tasks.on{flex-basis:var(--dual-chatw,420px)} }
  @media (max-width:1150px){
    body.dual-center #dualSplit,body.dual-center #view-ide.on{display:none}
    body.dual-center #view-tasks.on{flex:1 1 auto}
  }
 /* safe center:内容超高时顶部可达(flex 居中溢出截断的老 bug——轮次导航器点击第 1 轮暴露) */
  .chat-col{justify-content:flex-start;padding:14px 8px 14px 34px;gap:22px}
 /* 原 safe center 内容不足一屏时整列垂直居中(空态/短会话浮在中部+标签条错位)——改顶对齐 */
 /* 完整版轮次导航器(ZCode ConversationTurnNavigator 裁剪) */
  #view-tasks{position:relative;overflow-anchor:none}
 /* 轮次时间轴(右缘浮层融入 footer 状态条——minimap→scrubber):
 横向刻度=用户轮次,高度随问句长度(8-24px,--h 变量承载,hover/cur 可正常覆盖),金色=当前轮,红=该轮含失败任务 */
  #turnNav{flex:1;min-width:0;display:none;flex-direction:row;align-items:flex-end;gap:3px;overflow-x:auto;overflow-y:hidden;padding:2px 0 1px}
 /* 语义保留:nav 自身可滚,高亮器只动 nav.scrollLeft,绝不反向滚动会话视口 */
  #turnNav.on{display:flex}
  .tn-item{flex:0 0 auto;width:4px;height:var(--h,9px);border-radius:2px;background:var(--accent-soft);cursor:pointer;transition:.15s;overflow:hidden}
  .tn-item:hover{background:var(--bronze-dim);height:15px}
 /* 进度三态(按当前会话任务进度实时点亮,完成/就绪=满条):
 ok=该轮任务已完成(亮),run=会话有活动任务且该轮未决(呼吸),fail=该轮含失败(红);cur 金色高亮恒最上层 */
  .tn-item.ok{background:var(--bronze-dim)}
  .tn-item.ok:hover{background:var(--bronze)}
  .tn-item.run{background:var(--bronze-dim);animation:tnBreath 1.6s ease-in-out infinite}
  @keyframes tnBreath{0%,100%{opacity:.35}50%{opacity:.95}}
  .tn-item.fail{background:var(--red);opacity:.8}
  .tn-item.cur{background:linear-gradient(180deg,var(--grad-a),var(--grad-b));height:21px;width:6px;box-shadow:0 0 8px var(--bronze-glow);opacity:1;animation:none}
  .empty-line{color:var(--faint);font-family:var(--font-body);font-size:var(--fs-body-sm);letter-spacing:2px}
 /* 压缩边界行(ZCode TimelineMarkerRow 对齐)
 边界 pill 属徽标族(固定档 --fs-chip);边界整行块距纳入 --gap-msg */
  .cp-divider{display:flex;align-items:center;gap:8px;margin:var(--gap-msg) 0;padding:0 4px}
  .cp-line{flex:1;height:1px;background:var(--border-soft);opacity:.5}
  .cp-pill{font-family:var(--font-mono);font-size:var(--fs-chip);letter-spacing:1px;color:var(--faint);border:1px solid var(--border-soft);border-radius:999px;padding:1px 10px;white-space:nowrap}
 /* 板 n3:压缩边界行的可展开详情(pill 后「详情」小钉,收起态与旧观感一致)+ 指示 chip;
 失败/跳过走弱色变体(横线/pill 换色,不抢眼但一眼可辨)。 */
  .cp-divider{flex-wrap:wrap}
  .cp-divider .cp-more{font-family:var(--font-ui);font-size:var(--fs-chip);color:var(--faint);margin-left:2px}
  .cp-divider .cp-more>summary{list-style:none;cursor:pointer;border:1px solid var(--border-soft);border-radius:999px;padding:1px 8px;letter-spacing:1px;white-space:nowrap}
  .cp-divider .cp-more>summary::-webkit-details-marker{display:none}
  .cp-divider .cp-more>summary:hover{color:var(--muted);border-color:var(--border)}
  .cp-divider .cp-more[open]{flex:1 0 100%;order:9;margin-top:2px}
  .cp-divider .cp-more-body{margin:4px 0 0;padding:6px 10px;border-left:2px solid var(--border-soft);color:var(--muted);
    font-family:var(--font-body);font-size:var(--fs-body-sm);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
  .cp-divider .cp-row{margin-top:4px}
  .cp-divider .cp-chip{font-family:var(--font-mono);font-size:var(--fs-chip);letter-spacing:1px;color:var(--faint);
    border:1px solid var(--border-soft);border-radius:999px;padding:1px 8px;white-space:nowrap}
  .cp-divider .cp-tok{font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--faint)}
  .cp-divider.compact-failed .cp-line{background:var(--red);opacity:.45}
  .cp-divider.compact-failed .cp-pill{color:var(--red);border-color:var(--red);opacity:.85}
  .cp-divider.compact-skipped .cp-line{background:var(--faint);opacity:.35}
  .cp-divider.compact-skipped .cp-pill{color:var(--faint);border-color:var(--border-soft);opacity:.8}
 /* fixE22:顶窗渲染——窗口外占位(零高零布局,仅保 mfPatch 对位)与顶部「加载更早」哨兵 */
  .msg-ph{display:none}
 /* 历史分页入口:首屏只取末 200 条,更早事件靠顶部「加载更多历史」按游标回溯。
 视觉与顶窗哨兵同族(虚线 pill),但语义不同(远端翻页 vs 本地窗口展开)——共享一套声明,免两处漂移。 */
  .win-sent,.hist-more{margin:12px auto;max-width:420px;text-align:center;font-family:var(--font-ui);font-size:var(--fs-body-sm);letter-spacing:1px;color:var(--faint);
    border:1px dashed var(--border-soft);border-radius:999px;padding:7px 16px;cursor:pointer;user-select:none;transition:color .13s,border-color .13s}
  .win-sent:hover,.hist-more:hover{color:var(--muted);border-color:var(--border)}
 /* 空态时段问候(ZCode ConversationDraftEmptyState 对齐) */
  .draft-greet{font-family:var(--font-ui);font-size:calc(var(--fs-h1) * 0.9);color:var(--reply);letter-spacing:1px;margin-bottom:var(--gap-block)}
 /* (块4·4.3):草稿欢迎态「新会话」占位标题行(ref events.ts:624 New session 占位语义)——
 虚线 pill 与 .win-sent/.hist-more 同族(待收敛态);本仓无 LLM 标题轨,首发即 deriveTitle,
 占位只活在草稿欢迎态头部,首发后被派生标题取代(不闪)。 */
  .draft-newtitle{max-width:fit-content;font-family:var(--font-mono);font-size:var(--fs-chip);letter-spacing:2px;color:var(--faint);
    border:1px dashed var(--border-soft);border-radius:999px;padding:2px 14px;margin-bottom:var(--gap-block)}
  .draft-sub{font-family:var(--font-ui);font-size:var(--fs-body-sm);color:var(--faint);letter-spacing:2px;margin-bottom:20px}
 /* 回底圆钮(fixT6 P1):原为 absolute 且宿主是滚动容器 #view-tasks —— offsetParent 即滚动容器时按钮随内容滚走,
 实测上翻后 btnY 分别为 -6001/-12539/-23001(视口 48~673)=按钮 100% 不可见不可点(回底功能整体失效)。
 改 sticky 常驻滚动视口底部(实测 y 恒定 676、elementFromPoint 命中自身、点击 scrollTop 3146→6244 到位)。 */
  #scrollBottom{position:sticky;bottom:16px;align-self:flex-end;flex-shrink:0;margin-right:22px;
                opacity:0;transition:opacity .2s;pointer-events:none;z-index:25}
  #scrollBottom.on{opacity:1;pointer-events:auto}
 /* fixT6 P2:超长 agent 汇报折叠(经验证一条 2800 字汇报=4631px=7.3 屏,下接下一轮要狂滚);
 折起态给 max-height+渐隐遮罩,「展开全文」按钮在折起盒之外(不会被 overflow 裁掉)。 */
  .reply-wrap.reply-long:not(.open) .task-reply{max-height:420px;overflow:hidden;
 /* 渐隐用 mask 而非背景色遮罩(review nit):mask 不需要知道页面底色,七套主题下都天然正确
 ——初版写死 rgba(6,4,3,.92) 只在 dark 成立,浅色主题会出暗块。 */
    -webkit-mask-image:linear-gradient(180deg,#000 calc(100% - 64px),transparent 100%);
    mask-image:linear-gradient(180deg,#000 calc(100% - 64px),transparent 100%)}
  .reply-more{display:block;margin:var(--gap-tool) 0 2px;background:transparent;border:1px solid var(--border-soft);
    color:var(--bronze);border-radius:7px;font-size:var(--fs-tool);padding:2px 12px;cursor:pointer}
  .reply-more:hover{border-color:var(--bronze);color:var(--accent-bright)}
 /* user 消息气泡化(右对齐暖铜玻璃泡,与 task-reply/sys-line/cp-divider 一眼可分辨);
 主会话(message.user 渲染)与子代理工作区 steer 共用此类=纯 CSS 双路径生效,渲染端零结构变更。
 用户消息与 agent 正文同类同规格(font-body + fs-body + lh-body),左右缩进与正文对齐
 (max-width 收窄到正文栏宽,不再比正文更宽或更窄)。 */
  .user-line{width:fit-content;max-width:min(76%,720px);margin:var(--gap-tool) 2px var(--gap-tool) auto;display:flex;gap:10px;align-items:flex-start;
             font-family:var(--font-body);font-size:var(--fs-body);color:var(--text);line-height:var(--lh-body);overflow-wrap:anywhere;
             background:linear-gradient(135deg,var(--bubble-a),var(--bubble-b));
             border:1px solid var(--border-soft);border-radius:12px 12px 4px 12px;padding:7px 14px;
             box-shadow:0 1px 6px rgba(0,0,0,.18)}
  .user-line:hover{border-color:var(--border)}
  .user-line .who{flex-shrink:0;font-family:var(--font-ui);font-size:var(--fs-chip);color:var(--bronze);letter-spacing:1px;background:var(--chip-bg);
                  border:1px solid var(--border-soft);border-radius:4px;padding:0 6px;height:17px;line-height:var(--lh-tight);margin-top:2px}
  .user-line .txt{min-width:0}
  .user-line .msg-acts{align-self:flex-end;margin-bottom:1px;flex-shrink:0}
  .user-line .msg-acts button{white-space:nowrap}
 /* agent 正文容器=唯一「正文层」基准(font-body + fs-body + lh-body)。
 --reply-fs 仍由设置页注入(documentElement 行内变量,优先级高于本组令牌),未设置时回落到 --fs-body=19px。 */
  .task-reply{font-family:var(--font-body);font-size:var(--reply-fs,var(--fs-body));line-height:var(--lh-body);color:var(--reply);letter-spacing:var(--ls-body);overflow-wrap:anywhere;word-break:normal}
 /* 内嵌图片(截图预览):browser shot 的 ![…](/uploads?…) 渲染产物 */
  .task-reply img.md-img{display:block;max-width:100%;max-height:520px;margin:10px auto 6px;border-radius:10px;border:1px solid rgba(128,128,128,.35);box-shadow:0 2px 10px rgba(0,0,0,.18);cursor:zoom-in;background:#fff}
 /* 流式消息(ZCode 流式消息展示):打字光标+工具执行中行 */
  .st-cursor{display:inline-block;width:8px;height:1.05em;vertical-align:-3px;margin-left:4px;border-radius:1px;
             background:var(--bronze);box-shadow:0 0 8px var(--bronze-glow);animation:stblink 1s steps(2,start) infinite}
  @keyframes stblink{to{visibility:hidden}}
  .st-tool{display:flex;align-items:center;gap:9px;font-family:var(--font-mono);font-size:var(--fs-tool);color:var(--muted);
           padding:5px 12px;border:1px solid var(--border-soft);border-radius:9px;background:var(--glass);max-width:560px}
  .st-tool-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:var(--faint)}
  .st-tool.run .st-tool-dot{background:var(--bronze);animation:stpulse .9s ease-in-out infinite;box-shadow:0 0 8px var(--bronze-glow)}
  .st-tool.run .st-tool-state{color:var(--bronze)}
  .st-tool-state{margin-left:auto;letter-spacing:1px}
  @keyframes stpulse{0%,100%{opacity:.25}50%{opacity:1}}
  .task-reply .st{display:inline-block;font-family:var(--font-mono);font-size:var(--fs-chip);vertical-align:2px;
                  margin-left:10px;padding:1px 8px;border-radius:3px;letter-spacing:var(--ls-tight)}
  .st.queued{color:var(--warn);border:1px solid rgba(217,179,108,.35)}
  .st.running{color:var(--bronze);border:1px solid var(--border);animation:blink 1.2s infinite}
  .st.done{color:var(--green);border:1px solid rgba(157,192,139,.35)}
  .st.failed,.st.cancelled{color:var(--red);border:1px solid rgba(224,138,122,.35)}
  @keyframes blink{50%{opacity:.35}}
 /* 事件行(任务结算/白板/注入/LLM 轨迹)统一「元信息层」形态——
 mono 小字 + 左侧细条 + 略缩进,与正文(serif 大字)形成明确层级;不抢正文也不淹没 */
  .task-sub{font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--faint);margin:3px 0 3px 1px;line-height:var(--lh-tight);
    border-left:2px solid color-mix(in srgb,var(--bronze) 28%,transparent);padding:1px 0 1px 8px;letter-spacing:.2px}
 /* fixI11: 排队消息卡——时钟图标+「排队中」pill+正文+三按钮(立即发送/编辑/删除);
 发送后转正常用户消息气泡(队列移除+journal message.user 到达)。
 排队卡=用户消息的未发送态,正文与 .user-line 同规格(font-body + fs-body + lh-body)。 */
  .qm-card{display:flex;align-items:flex-start;gap:8px;margin:var(--gap-tool) 0 2px auto;max-width:86%;padding:8px 12px;border:1px dashed rgba(217,179,108,.45);border-radius:12px 4px 12px 12px;background:rgba(217,179,108,.06)}
  .qm-card .qm-clock{flex:none;width:15px;height:15px;margin-top:2px;color:var(--warn);animation:stpulse 2.4s infinite}
  .qm-card .qm-body{flex:1;min-width:0}
  .qm-card .qm-tag{display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:var(--fs-chip);letter-spacing:1px;color:var(--warn);margin-bottom:3px}
  .qm-card .qm-txt{font-family:var(--font-body);font-size:var(--fs-body);line-height:var(--lh-body);color:var(--text);overflow-wrap:anywhere;white-space:pre-wrap}
  .qm-card .qm-acts{display:flex;gap:6px;margin-top:6px}
  .qm-card .qm-acts button{font-family:var(--font-mono);font-size:var(--fs-tool);padding:2px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer}
  .qm-card .qm-acts button:hover{color:var(--text);border-color:var(--bronze)}
  .qm-card .qm-acts button.qm-now{color:var(--accent-bright);border-color:rgba(217,179,108,.5)}
  #go.queue-mode{border-color:rgba(217,179,108,.55);color:var(--warn)}
 /* (块4·4.6):draftSubmitPending 等待态——发送按钮禁点+呼吸点视觉(防重复点击;
 样式与 compact-wait 同形,互斥关系见 renderSendBtn 尾部同步块)。 */
  #go.wait-ack{border-color:rgba(217,179,108,.55);color:var(--warn);animation:stpulse 1.6s infinite}
  .ev-line{font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--faint);padding:1px 0 1px 10px;line-height:var(--lh-tight)}
 /* fix:超宽消息行约束——事件元信息行(.task-sub/.ev-line)与工具行块(.tr-lines .cl、
 分组工具块 .tc-body)此前没有任何换行约束,一条无空格长串(URL/哈希/长路径)把消息区横向撑开、
 撑破卡内布局(画布形态下直接穿透卡片边界,用户截图实测确认)。
 白名单:body.nowrapcode 的 pre.code 保持 nowrap+overflow-x:auto——代码块可横向滚动,但不撑破卡片。 */
  .task-sub,.ev-line{overflow-wrap:anywhere;word-break:break-word}
 /* LLM 轨迹行(修复):构型/模型/耗时全部收在一行内,超宽省略;「复制轨迹路径」固定在右端,
 不再被长 roles 链冲走。构型本身已由 roleShape 压缩,title 里保留全量。 */
  .llm-trace-line{display:flex;align-items:baseline;gap:8px;white-space:nowrap;overflow:hidden}
  .llm-trace-line .lt-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
  .llm-trace-line .lt-roles{color:var(--bronze-dim)}
  .llm-trace-line .lt-copy{flex:none;font-size:var(--fs-chip);letter-spacing:.3px;color:var(--bronze-dim);
    border:1px solid rgba(217,179,108,.28);border-radius:5px;padding:0 6px;line-height:var(--lh-tight)}
  .llm-trace-line:hover .lt-copy{color:var(--accent-bright);border-color:var(--bronze)}
  .tr-lines .cl{overflow-wrap:anywhere}
  .tool-card .tc-body,.tool-group .tg-item .tc-body{overflow-wrap:anywhere}
 /* 技能/命令占位行(ZCode optimistic command overlay 对齐) */
  .skill-inv{display:flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:var(--fs-tool);line-height:var(--lh-tight);
    color:var(--muted);padding:4px 10px;margin:var(--gap-tool) 0;border:1px dashed var(--border-soft);border-radius:8px}
  .skill-inv .si-k{color:var(--accent-bright)}
  .skill-inv .si-a{color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
  .skill-inv .si-st{margin-left:auto;color:var(--faint)}
  .skill-inv .si-st.done{color:var(--green)}
 /* chip/徽标全族统一固定档 --fs-chip(11px),不随正文/代码字号缩放 */
  .slash-chip{display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--accent-bright)}
  .slash-chip .sc-icon{font-size:var(--fs-chip);color:var(--bronze)}
  .slash-chip .sc-args{color:var(--muted);font-size:var(--fs-chip)}
 /* user 消息 chip 渲染的 remainder 展示态(raw 前缀行成 chip,模板体隐藏后的用户正文/未识别余文)
 余文=用户正文的一部分,走 font-body + fs-body 同一规格 */
  .user-line .u-slash-body{display:block;margin-top:3px;font-family:var(--font-body);font-size:var(--fs-body);
    line-height:var(--lh-body);color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere}
 /* 文件引用 chip(对齐 ref/zcode PromptMention files 形态):输入区与聊天流气泡共用一套视觉。
 点击=在 IDE 打开该文件;目录补尾斜杠并发目录语义(▸ 图标)。 */
  .file-chip{display:inline-flex;align-items:center;gap:4px;font-family:var(--font-mono);font-size:var(--fs-chip);
    line-height:var(--lh-tight);color:var(--text);background:var(--chip-bg);border:1px solid var(--border-soft);
    border-radius:6px;padding:1px 7px;margin:0 2px;cursor:pointer;max-width:100%;vertical-align:baseline}
  .file-chip:hover{border-color:var(--bronze)}
  .file-chip:focus-visible{outline:2px solid var(--focus-ring);outline-offset:1px}
  .file-chip .fc-ic{color:var(--bronze);flex-shrink:0}
  .file-chip .fc-nm{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
  .file-chip .fc-dir{color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
  .ev-chip{display:inline-block;font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--bronze);
           border:1px solid var(--border-soft);border-radius:5px;padding:1px 8px;margin:2px 4px 2px 0}
  .ev-chip .a{color:var(--faint)}
  .ev-time{color:var(--faint);opacity:.7;margin-right:6px}

 /* 泛用面板视图(洞察/自动化/经验库/系统) */
  .panel-wrap{padding:14px 8px 14px 34px;gap:12px}
  .vw-head{display:flex;align-items:baseline;gap:8px 14px;row-gap:8px;flex-wrap:wrap;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--border-soft)}
  .vw-title{font-family:var(--serif);font-size:20px;letter-spacing:2px;color:var(--brand);font-weight:600}
  .vw-sub{font-size:12px;color:var(--faint);letter-spacing:0.5px}
 /* n10 看板作用域标注:吃项目级/全局数据的卡必须写清,避免用户误以为是当前会话数据 */
  .vw-scope{font-size:10px;color:var(--bronze-dim);border:1px solid var(--border-soft);border-radius:8px;padding:1px 7px;white-space:nowrap;cursor:help}
  body.cv-shell .vw-scope{font-size:9px;padding:0 5px}
  .vw-act{margin-left:auto;font-size:10px;color:var(--muted);border:1px solid var(--border-soft);white-space:nowrap;flex-shrink:0;
          border-radius:7px;padding:4px 12px;cursor:pointer;background:transparent}
  .vw-act:hover{border-color:var(--bronze);color:var(--text)}
  .wf-card{border:1px solid var(--border-soft);border-radius:12px;background:var(--glass2);padding:14px 16px;max-width:640px}
  .wf-name{font-size:13px;color:var(--text);letter-spacing:1px}
  .wf-desc{font-size:10px;color:var(--faint);margin-top:3px;line-height:1.7}
  .wf-args{width:100%;margin-top:9px;background:var(--glass);border:1px solid var(--border-soft);border-radius:8px;
           color:var(--text);padding:7px 10px;font-family:var(--mono);font-size:10.5px;outline:none}
  .wf-args:focus{border-color:var(--bronze)}
  .wf-args.bad{border-color:var(--red)}
  .wf-go{margin-top:9px;font-size:11px;color:var(--accent-bright);border:1px solid var(--border);
         border-radius:8px;padding:5px 16px;background:transparent;letter-spacing:2px}
  .wf-go:hover{background:linear-gradient(135deg,var(--grad-a),var(--grad-b));color:var(--on-accent)}
  .wf-err{font-size:10px;color:var(--red);margin-top:6px;display:none}
  .exp-item{border-bottom:1px solid var(--border-soft);padding:10px 4px;cursor:pointer;max-width:640px}
  .exp-item:hover{background:var(--hover-bg)}
  .exp-cat{display:inline-block;font-family:var(--mono);font-size:9px;color:var(--bronze);
           border:1px solid var(--border-soft);border-radius:4px;padding:0 6px;margin-right:8px}
  .exp-name{font-size:12.5px;color:var(--text)}
  .exp-desc{font-size:10.5px;color:var(--muted);margin-top:3px;line-height:1.6}
  .exp-body{font-family:var(--mono);font-size:11px;line-height:1.8;color:var(--muted);white-space:pre-wrap;
            border-left:2px solid var(--bronze-dim);padding-left:12px;max-width:680px;word-break:break-word}
  .kv{display:grid;grid-template-columns:130px 1fr;gap:4px 14px;font-size:11.5px;max-width:680px}
  .kv .k{color:var(--faint)}
  .kv .v{color:var(--muted);font-family:var(--mono);word-break:break-all}

 /* ===== 成熟面板组件:思考卡/变更条/运行时长/双 pill/会话标签页/统计图表 ===== */
 /* 表格可读性:表宽自撑、单元格加内边距、隔行底色(长表横向追踪行不串行)、
 表头字重 600 且不折行;宽表由 mdToHtml 外包的 .md-table-wrap 横向滚动,不再挤压列宽。 */
  .md-table-wrap{max-width:100%;overflow-x:auto;overflow-y:hidden;margin:var(--gap-block) 0;
    border:1px solid var(--border-soft);border-radius:8px}
  .md-table-wrap>.md-table{margin:0;border:none}
  .md-table{border-collapse:collapse;margin:var(--gap-block) 0;font-size:var(--fs-body-sm);line-height:var(--lh-tight);width:auto;max-width:100%}
  .md-table th,.md-table td{border:1px solid var(--border-soft);padding:8px 12px;text-align:left;vertical-align:top}
  .md-table th{background:var(--accent-soft);color:var(--text);border-bottom:2px solid var(--bronze);font-weight:600;white-space:nowrap} /* 亮色系对比度:bronze 字在浅底仅 ~1.9:1 → 语义文本色 + 铜色底边保视觉身份 */
  .md-table tbody tr:nth-child(even){background:rgba(201,143,69,.055)}
  .md-table tbody tr:hover{background:rgba(201,143,69,.11)}
  .md-quote{border-left:3px solid var(--bronze);margin:var(--gap-block) 0;padding:4px 12px 4px var(--indent-1);
    color:var(--muted);background:var(--hover-bg);font-size:var(--fs-body-sm);line-height:var(--lh-body)}
 /* 所有 code-wrap 一律带板(默认=代码板色),is-term/is-json 再覆写——
 旧实现纯文本结果只有一圈细边、和白纸正文糊在一起,这是「看不出哪里是重点」的主因之一。
 整族板统一一套排版(font-mono + fs-code + lh-code)、统一 border-radius 与内容 padding
 ——板内 pre.code 与 .tc-body 取同一值,不再因外层是工具卡而各用一套内距。 */
  .code-wrap{border:1px solid var(--border-soft);border-radius:9px;overflow:hidden;margin:var(--gap-tool) 0;
    background:var(--surf-code);font-family:var(--font-mono);font-size:var(--fs-code);line-height:var(--lh-code)}
  .code-bar{display:flex;align-items:center;justify-content:space-between;padding:3px 10px;
    background:var(--hover-bg);border-bottom:1px solid var(--border-soft);
    font-family:var(--font-mono);font-size:var(--fs-tool);line-height:var(--lh-code);color:var(--faint)}
 /* 视觉分层:语言名从灰字升为「类型铭牌」(左色点+mono),一眼分辨这是代码/终端/JSON */
  .code-bar .code-lang{display:inline-flex;align-items:center;gap:5px;letter-spacing:.4px}
  .code-bar .code-lang::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--bronze);opacity:.7;flex-shrink:0}
  .code-copy{border:none;background:transparent;color:var(--faint);cursor:pointer;
    font-family:var(--font-mono);font-size:var(--fs-tool);padding:1px 6px}
  .code-copy:hover{color:var(--bronze)}
  .code-wrap pre.code{border:none;border-radius:0;margin:0;background:transparent;
    padding:var(--gap-block) 10px;font-family:var(--font-mono);font-size:var(--fs-code);line-height:var(--lh-code)}
  .code-wrap>.tc-body{padding:var(--gap-block) 10px;font-family:var(--font-mono);
    font-size:var(--fs-code);line-height:var(--lh-code);color:var(--faint)}
 /* 终端板体嵌在工具卡内时会被 .tool-card .tc-body(同权重、源序更后)压成 code-sm 档
 ——这里提权一档锁回板族本体档,保证「终端板行与代码板同字号」。 */
  .code-wrap.is-term>.tc-body,.code-wrap.is-term .tc-body{font-size:var(--fs-code);line-height:var(--lh-code)}
 /* --- 内容类型板:同一 .code-wrap 家族,按类型给不同底色/边/左色条(七主题经 --surf-* 跟随) --- */
  .code-wrap.is-code{background:var(--surf-code)}
  .code-wrap.is-code pre.code{color:var(--text)}
  .code-wrap.is-term{background:var(--surf-term);border-color:color-mix(in srgb,var(--green) 22%,var(--border-soft));
    box-shadow:inset 3px 0 0 color-mix(in srgb,var(--green) 45%,transparent)}
  .code-wrap.is-term pre.code,.code-wrap.is-term .tc-body{color:color-mix(in srgb,var(--text) 82%,var(--green))}
  .code-wrap.is-term .code-bar{color:color-mix(in srgb,var(--green) 60%,var(--faint))}
  .code-wrap.is-term .code-bar .code-lang::before{background:var(--green)}
  .code-wrap.is-term.tc-fail{background:var(--surf-fail);border-color:color-mix(in srgb,var(--red) 45%,var(--border-soft));
    box-shadow:inset 3px 0 0 color-mix(in srgb,var(--red) 60%,transparent)}
  .code-wrap.is-term.tc-fail .code-bar{color:var(--red)}
  .code-wrap.is-term.tc-fail .code-bar .code-lang::before{background:var(--red)}
  .code-wrap.is-json{background:var(--surf-json);border-color:var(--border-soft)}
  .code-wrap.is-json .code-bar .code-lang::before{background:var(--tok-num)}
 /* JSON 结构分色(键/字符串/数值)——纯文本正则不可用,改由渲染端打 span;见 renderJsonBlock */
  .code-wrap.is-json .cl .jk{color:var(--bronze)}
  .code-wrap.is-json .cl .js{color:var(--tok-str)}
  .code-wrap.is-json .cl .jn{color:var(--tok-num)}
  .code-wrap.is-json .cl .jb{color:var(--tok-bool)}
 /* --- 行级调子:终端/输出里的错误行/警告行/命令行各成一色(优先级低于语义 token 着色) --- */
  pre.code .cl.tl-err, .tr-lines .cl.tl-err{color:var(--red)}
  pre.code .cl.tl-warn, .tr-lines .cl.tl-warn{color:var(--warn)}
  pre.code .cl.tl-ok, .tr-lines .cl.tl-ok{color:var(--green)}
  pre.code .cl.tl-cmd, .tr-lines .cl.tl-cmd{color:var(--bronze);font-weight:600}
  pre.code .cl.tl-dim, .tr-lines .cl.tl-dim{color:var(--faint)}
 /* 错误行加左侧细标,长输出里能一眼定位(行内伪元素不撑高) */
  pre.code .cl.tl-err, .tr-lines .cl.tl-err{background:color-mix(in srgb,var(--red) 9%,transparent);
    box-shadow:inset 2px 0 0 color-mix(in srgb,var(--red) 55%,transparent)}
 /* 薄墨主题(ink=克制单色,唯一朱红留给定性错误):终端板的绿边/绿调去掉,改灰阶分层 */
  body.theme-ink .code-wrap.is-term{border-color:var(--border);
    box-shadow:inset 3px 0 0 color-mix(in srgb,var(--text) 22%,transparent)}
  body.theme-ink .code-wrap.is-term pre.code,body.theme-ink .code-wrap.is-term .tc-body{color:var(--text)}
  body.theme-ink .code-wrap.is-term .code-bar{color:var(--muted)}
  body.theme-ink .code-wrap.is-term .code-bar .code-lang::before{background:var(--text);opacity:.55}
 /* 思考卡=无衬线讲述层(不是正文衬线),正文一档以下=fs-body-sm,行高取正文 lh-body(比工具卡松) */
  .think-card{border:1px solid var(--border-soft);border-radius:9px;background:var(--sunken);
    margin:var(--gap-tool) 0;font-family:var(--font-ui)}
  .think-card summary{cursor:pointer;font-family:var(--font-ui);font-size:var(--fs-tool);line-height:var(--lh-tight);
    color:var(--faint);padding:5px 10px;list-style:none;user-select:none}
  .think-card summary::before{content:'» ';color:var(--bronze-dim)}
  .think-card[open] summary{border-bottom:1px solid var(--border-soft)}
  .think-card .th-body{font-family:var(--font-ui);font-size:var(--fs-body-sm);line-height:var(--lh-body);color:var(--muted);
    padding:var(--gap-block) 12px;white-space:pre-wrap}
 /* 调用轨迹聚合卡:连续 LLM 调用的 trace 行 + 思考内容收成一张可展开卡,
 与工具分组卡同语言(默认闭合、summary 给次数与 roles 计数),把消息流高度还给正文。 */
  .trace-group{border:1px solid var(--border-soft);border-radius:9px;background:var(--sunken);margin:var(--gap-tool) 0}
  .trace-group>summary{cursor:pointer;font-family:var(--font-ui);font-size:var(--fs-tool);line-height:var(--lh-tight);
    color:var(--faint);padding:5px 10px;list-style:none;user-select:none;
    display:flex;align-items:center;gap:6px}
  .trace-group>summary::before{content:'» ';color:var(--bronze-dim)}
  .trace-group[open]>summary{border-bottom:1px solid var(--border-soft)}
  .trace-group .tg-roles{font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--bronze-dim)}
  .trace-group .task-sub,.trace-group .think-card{margin:2px 8px}
  .trace-group .think-card{border-color:transparent;background:transparent}
 /* 变更条/运行时长属消息流元信息层,与工具卡同规格(板档 + mono) */
  .diffbar{display:flex;align-items:center;gap:8px;margin:var(--gap-tool) 0;padding:6px 12px;border:1px solid rgba(157,192,139,.25);border-radius:9px;
    background:rgba(157,192,139,.07);font-size:var(--fs-code-sm);line-height:var(--lh-code);color:var(--muted)}
  .diffbar .da{color:var(--green);font-family:var(--font-mono)}
  .diffbar .dd{color:var(--red);font-family:var(--font-mono)}
  .diffbar .files-link{cursor:pointer;text-decoration:underline dotted;color:var(--text)}
  .diffbar button{margin-left:auto;font-family:var(--font-mono);font-size:var(--fs-tool);color:var(--red);background:transparent;border:1px solid rgba(224,138,122,.4);border-radius:6px;padding:2px 10px;cursor:pointer}
  .diffbar button:hover{background:rgba(224,138,122,.12)}
  .work-timer{font-family:var(--font-mono);font-size:var(--fs-tool);line-height:var(--lh-tight);color:var(--bronze);white-space:nowrap}
  .mode-pill{font-size:10.5px;color:var(--muted);border:1px solid var(--border-soft);border-radius:999px;padding:1px 9px;cursor:pointer;white-space:nowrap;user-select:none}
 /* 命令「真执行」徽标(视频):亮=该输入经提交分发真实执行;done=已执行闪确认;warn=仅菜单可选
 徽标字号统一固定档 --fs-chip(不随正文/代码字号缩放) */
  .cmd-chip{display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--bronze);border:1px solid var(--bronze);
    border-radius:999px;padding:1px 10px;white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis;cursor:default}
  .cmd-chip::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
  .cmd-chip b{color:var(--text);font-weight:600}
  .cmd-chip.done{color:var(--green);border-color:var(--green)}
 /* 技能执行反馈闭环(视频 T3):journal message.system(目标切换/续跑通知)在聊天流可见 */
 /* 系统行=「分隔型元信息」——淡底胶囊+居中细线,与正文/工具卡都不混层。
 系统/通知行统一 --fs-body-sm + --font-ui + 弱色,块距纳入 --gap-msg(上下各半档)。 */
  .sys-line{font-family:var(--font-ui);font-size:var(--fs-body-sm);line-height:var(--lh-tight);color:var(--bronze);letter-spacing:.4px;
    margin:var(--gap-msg) 0 calc(var(--gap-msg) / 2);display:flex;align-items:center;gap:8px;
    background:color-mix(in srgb,var(--bronze) 6%,transparent);border-radius:7px;padding:3px 10px}
  .sys-line::before{content:'';width:16px;height:1px;background:var(--bronze);opacity:.55;flex-shrink:0}
 /* 被拒/异常系统行:plan-gate 等工具层拒绝曾经只显示绿色「完成」导致用户误判——
 拒绝行人话 + 暖红描边,与普通通知行一眼可分。 */
  .sys-line.sys-warn{color:var(--red);background:color-mix(in srgb,var(--red) 8%,transparent)}
  .sys-line.sys-warn::before{background:var(--red);opacity:.7}
 /* tips 注入留痕:loop 的 ephemeral tip 旁路落 journal tip.injected,此处可折叠展示
 「tips · 类别 · 第 N 步 · 字符数」,展开看注入原文。形态与系统行同族(淡底+细线),
 但用 <details> 收起长块——code-orient/history-align 动辄数千字,不许刷屏。 */
  .tip-line{font-family:var(--font-ui);font-size:var(--fs-body-sm);line-height:var(--lh-tight);color:var(--bronze);
    margin:var(--gap-msg) 0 calc(var(--gap-msg) / 2);background:color-mix(in srgb,var(--bronze) 5%,transparent);
    border-left:2px solid color-mix(in srgb,var(--bronze) 45%,transparent);border-radius:0 7px 7px 0;padding:3px 10px}
  .tip-line>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;letter-spacing:.4px}
  .tip-line>summary::-webkit-details-marker{display:none}
  .tip-line>summary::before{content:'\\25B8';color:var(--bronze);opacity:.7;flex-shrink:0;transition:transform .15s ease}
  .tip-line[open]>summary::before{transform:rotate(90deg)}
  .tip-line .tl-tag{font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--accent-bright,var(--bronze));
    border:1px solid color-mix(in srgb,var(--bronze) 50%,transparent);border-radius:999px;padding:0 8px;flex-shrink:0}
  .tip-line .tl-keys{color:var(--text);font-weight:600}
  .tip-line .tl-meta{color:var(--faint);margin-left:auto;flex-shrink:0}
  .tip-line .tl-body{margin-top:4px;padding-top:4px;border-top:1px dashed var(--border-soft);
    font-family:var(--font-mono);font-size:var(--fs-code-sm);line-height:var(--lh-code);color:var(--muted);white-space:pre-wrap;word-break:break-word}
 /* 轨迹卡(J1 2026-11 token 轮):loop 每 N 步旁路落 task.trajectory(只含计数/比率,无对话正文),
 渲染为与 tip-line 同族的折叠卡——summary 一行给「走到哪」的画像,展开给工具分布+token 曲线。
 与 tip-line 同族底色/左描边,但用 --faint 弱色强调「这是画像不是内容」。 */
  .traj-line{font-family:var(--font-ui);font-size:var(--fs-body-sm);line-height:var(--lh-tight);color:var(--muted);
    margin:var(--gap-msg) 0 calc(var(--gap-msg) / 2);background:color-mix(in srgb,var(--bronze) 4%,transparent);
    border-left:2px solid color-mix(in srgb,var(--bronze) 32%,transparent);border-radius:0 7px 7px 0;padding:3px 10px}
  .traj-line>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;letter-spacing:.4px}
  .traj-line>summary::-webkit-details-marker{display:none}
  .traj-line>summary::before{content:'\\25B8';color:var(--bronze);opacity:.7;flex-shrink:0;transition:transform .15s ease}
  .traj-line[open]>summary::before{transform:rotate(90deg)}
  .traj-line .tj-tag{font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--bronze);
    border:1px solid color-mix(in srgb,var(--bronze) 40%,transparent);border-radius:999px;padding:0 8px;flex-shrink:0}
  .traj-line .tj-sub{margin:4px 0 0;color:var(--faint)}
  .traj-line .tj-bars{margin:4px 0 0;display:flex;flex-direction:column;gap:2px}
  .traj-line .traj-bar{display:flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--faint)}
  .traj-line .traj-bar span{width:96px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .traj-line .traj-bar i{height:5px;border-radius:3px;background:color-mix(in srgb,var(--bronze) 55%,transparent);min-width:1px}
  .traj-line .traj-bar b{color:var(--muted);font-weight:400}
  .traj-line .tj-spark{margin-top:4px;color:var(--bronze)}
  .traj-line .tj-spark polyline{fill:none;stroke:currentColor;stroke-width:1.2;opacity:.85}
 /* 轨迹卡「看板」入口:卡片 summary 右侧,点击开全屏看板,不展开 details */
  .traj-line .tj-open{cursor:pointer;font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--bronze-dim);
    border:1px solid var(--border-soft);border-radius:6px;padding:0 6px;line-height:15px;flex-shrink:0}
  .traj-line .tj-open:hover{color:var(--bronze);border-color:var(--bronze)}
  .traj-line .tj-tok{font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--muted);margin-left:auto}
 /* ===== 轨迹看板( → 拆为独立视图):#view-traj 内常驻三 pane 内容区。
 原形态是全屏 overlay(position:fixed + 遮罩 + Esc 关闭), 起改为视图内常驻区:
 不遮罩、不锁 body 滚动、不用 display 开关(视图身份由 applyViewChrome 决定)。
 主题色全部走既有变量,不新造色值 ===== */
  .traj-board{display:flex;flex-direction:column;gap:8px;flex:0 0 auto}
  .traj-board-box{display:flex;flex-direction:column;gap:8px;
    background:var(--glass2);border:1px solid var(--border);border-radius:12px;padding:10px 12px;overflow:hidden}
  .tb-head{display:flex;align-items:center;gap:10px;flex-shrink:0}
  .tb-title{font-size:12px;letter-spacing:1.4px;color:var(--bronze)}
  .tb-sid{font-family:var(--font-mono);font-size:10.5px;color:var(--faint)}
  .tb-sum{display:flex;flex-wrap:wrap;gap:3px 16px;flex-shrink:0;font-size:10.5px;color:var(--muted);
    padding:5px 9px;border:1px solid var(--border-soft);border-radius:8px;background:var(--sunken)}
  .tb-sum b{font-family:var(--font-mono);color:var(--text);font-weight:600;margin-left:4px}
  .tb-bar{display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap}
  .tb-chip{cursor:pointer;user-select:none;font-size:10.5px;padding:0 8px;line-height:19px;border:1px solid var(--border-soft);
    border-radius:999px;color:var(--muted)}
  .tb-chip:hover{color:var(--text);border-color:var(--bronze-dim)}
  .tb-chip.on{color:var(--accent-bright);border-color:var(--bronze);background:var(--accent-soft)}
  .tb-search{flex:1;min-width:120px;background:var(--sunken);border:1px solid var(--border-soft);border-radius:6px;
    color:var(--text);font-family:var(--font-ui);font-size:10.5px;padding:2px 8px}
  .tb-search::placeholder{color:var(--faint)}
  .tb-body{flex:1;display:flex;gap:8px;min-height:420px}
  .tb-table{flex:1;min-width:0;overflow:auto;border:1px solid var(--border-soft);border-radius:8px;background:var(--sunken)}
  .tb-hd,.tb-row{display:grid;grid-template-columns:38px 54px 1fr 56px 52px 52px 52px 46px;gap:6px;align-items:center;padding:0 8px}
  .tb-hd{position:sticky;top:0;z-index:1;height:22px;font-size:10px;letter-spacing:.6px;color:var(--faint);
    background:var(--solid);border-bottom:1px solid var(--border-soft)}
  .tb-row{height:24px;font-size:10.5px;line-height:24px;color:var(--muted);cursor:pointer;
    border-bottom:1px solid var(--border-soft)}
  .tb-row:hover{background:var(--glass2)}
  .tb-row.sel{background:var(--accent-soft);box-shadow:inset 2px 0 0 var(--bronze)}
  .tb-row.err .s{color:var(--red)}
  .tb-row .n{font-family:var(--font-mono);color:var(--faint)}
  .tb-row .k{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tb-row .s{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tb-row .d,.tb-row .t{font-family:var(--font-mono);color:var(--faint);text-align:right}
  .tb-row .st{font-size:10px;color:var(--green)}
  .tb-row .st.err{color:var(--red)}
  .tb-row .st.pending{color:var(--faint)}
  .tb-trhead{display:flex;align-items:center;gap:10px;height:24px;padding:0 8px;font-size:10px;letter-spacing:.5px;
    color:var(--bronze);background:var(--sunken);border-bottom:1px solid var(--border-soft);
    border-top:1px solid var(--border-soft)}
  .tb-trhead .h{font-family:var(--font-mono);color:var(--faint)}
 /* 看板默认折叠 —— 行表按轮收起;屏外组 content-visibility:auto 跳过布局/绘制 */
  .tb-rowfold{border-bottom:1px solid var(--border-soft)}
  .tb-rowfold>summary{list-style:none;cursor:pointer}
  .tb-rowfold>summary::-webkit-details-marker{display:none}
  .tb-trsum{display:flex;align-items:center;gap:8px}
  .tb-trsum .tb-trhead{flex:1;border:none;height:22px;background:transparent}
  .tb-trnum{margin-left:auto;padding-right:10px;font-family:var(--font-mono);font-size:9.5px;color:var(--faint)}
  .tb-trbody{content-visibility:auto;contain-intrinsic-size:auto 320px}
  .tb-warn{font-size:10.5px;color:var(--warn);padding:4px 9px;border-bottom:1px solid var(--border-soft);
    font-family:var(--font-mono)}
  .tb-empty{padding:18px;text-align:center;color:var(--faint);font-size:11px;letter-spacing:.6px}
 /* ---- 轨迹泳道 pane(从 status-widget.js 迁入;class 名 sw-lane/sw-rec/sw-turn 同名复用,
 两侧不再重复定义:status-widget.js 内已无这套样式) ---- */
  .traj-lanes{flex:1;min-width:0;overflow:auto;border:1px solid var(--border-soft);border-radius:8px;background:var(--sunken);padding:6px}
  .traj-lanes-box{position:relative;min-height:240px}
  .traj-lane-sum{display:flex;flex-wrap:wrap;gap:3px 14px;font-size:10px;color:var(--muted);
    padding:4px 9px;border:1px solid var(--border-soft);border-radius:8px;background:var(--sunken)}
  .traj-lane-sum b{font-family:var(--font-mono);color:var(--text);font-weight:600;margin-left:4px}
  .traj-lane-sum .err{color:var(--red)}
  .traj-lane-sum .k{color:var(--faint);letter-spacing:.6px}
  .sw-lane{position:relative;height:74px;border-top:1px dashed var(--border-soft);margin-bottom:8px}
  .sw-lane-label{position:sticky;left:0;font-size:8px;letter-spacing:2px;color:var(--faint);margin-bottom:2px}
  .sw-rec{position:absolute;top:22px;width:78px;font-family:var(--font-mono);font-size:8.5px;line-height:1.45;
    color:var(--text);background:var(--accent-soft);border:1px solid var(--border-soft);border-radius:6px;
    padding:3px 5px;cursor:default;overflow:hidden;max-height:46px}
  .sw-rec .d{color:var(--bronze)}
  .sw-rec.err{border-color:var(--red)}
  .sw-rec.user{background:var(--glass2)}
  .sw-rec .dur{position:absolute;left:0;bottom:0;height:2px;background:var(--bronze)}
  .sw-turn{position:absolute;top:0;bottom:0;width:1px;background:var(--bronze-dim)}
  .sw-turn span{position:absolute;top:2px;left:3px;font-size:8px;letter-spacing:1px;color:var(--bronze)}
  .tb-insp{width:300px;flex-shrink:0;overflow:auto;border:1px solid var(--border-soft);border-radius:8px;
    padding:8px 10px;background:var(--glass2);font-size:10.5px;color:var(--muted)}
  .tb-insp .r{display:flex;gap:8px;margin:2px 0;line-height:16px}
  .tb-insp .r .k{width:76px;flex-shrink:0;color:var(--faint)}
  .tb-insp .r .v{color:var(--text);word-break:break-all;flex:1;min-width:0}
  .tb-insp .errtext{margin-top:6px;padding:5px 7px;border:1px solid var(--red);border-radius:6px;
    color:var(--red);font-family:var(--font-mono);font-size:10px;white-space:pre-wrap;word-break:break-all;
    user-select:text;cursor:text}
  .tb-insp .ihint{color:var(--faint);letter-spacing:.6px}
 /* ===== 逐次决策卡:一次 LLM 决策一张卡;干条常显,卡体懒加载 ===== */
  .tb-cards{flex:1;min-width:0;overflow:auto;border:1px solid var(--border-soft);border-radius:8px;background:var(--sunken);padding:6px}
  .tb-card{border:1px solid var(--border-soft);border-radius:7px;margin:5px 0;background:var(--glass2);overflow:hidden}
  .tb-card.err{border-color:var(--red)}
  .tb-card .tb-c-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;padding:5px 9px;
    font-size:10.5px;line-height:17px;color:var(--muted);cursor:pointer;user-select:none}
  .tb-card .tb-c-head:hover{background:var(--glass2)}
  .tb-card .tb-c-head .n{font-family:var(--font-mono);color:var(--bronze)}
  .tb-card .tb-c-head .pos,.tb-card .tb-c-head .num{font-family:var(--font-mono);color:var(--faint)}
  .tb-card .tb-c-head .model{color:var(--text)}
  .tb-card .tb-c-head .tools{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px}
  .tb-card .tb-c-head .bad{color:var(--red);border:1px solid var(--red);border-radius:4px;padding:0 4px;font-size:9.5px}
  .tb-card .tb-c-head .fold{margin-left:auto;color:var(--bronze-dim);font-size:10px}
  .tb-card .tb-c-body{padding:2px 9px 8px;border-top:1px solid var(--border-soft)}
  .tb-card .tb-c-sec{font-size:10px;letter-spacing:.8px;color:var(--bronze);padding:7px 0 3px}
  .tb-card .tb-c-hit{margin:2px 0 4px;padding:3px 7px;border:1px dashed var(--border-soft);border-radius:5px;
    font-family:var(--font-mono);font-size:10px;color:var(--faint);user-select:text;cursor:text}
  .tb-card .tb-c-none{font-size:10px;color:var(--faint);padding:2px 0}
  .tb-card .tb-c-loading{font-size:10px;color:var(--faint);padding:6px 0}
  .tb-card .tb-c-msg{margin:4px 0;border-left:2px solid var(--border-soft);padding-left:7px}
  .tb-card .tb-c-msg .h{display:flex;gap:8px;font-family:var(--font-mono);font-size:10px;color:var(--faint)}
  .tb-card .tb-c-msg .h .role{color:var(--accent-bright)}
  .tb-card .tb-c-msg.sys{border-left-color:var(--bronze)}
  .tb-card pre.tb-c-pre{margin:3px 0;padding:5px 8px;background:rgba(0,0,0,.25);border-radius:5px;
    font-family:var(--font-mono);font-size:10.5px;line-height:15px;color:var(--text);
    white-space:pre-wrap;word-break:break-word;user-select:text;cursor:text;max-height:none;overflow:visible}
  .tb-card pre.tb-c-pre.out{border-left:2px solid var(--green)}
  .tb-card pre.tb-c-pre.think{color:var(--muted);border-left:2px solid var(--bronze-dim)}
  .tb-card pre.tb-c-pre.err{color:var(--red);border-left:2px solid var(--red)}
  .tb-card details.tb-c-det{margin:3px 0}
  .tb-card details.tb-c-det summary{cursor:pointer;font-size:10px;color:var(--bronze-dim)}
  .tb-card .tb-c-trunc{font-size:10px;color:var(--warn)}
  .tb-card .tb-c-foot{margin-top:7px;padding-top:5px;border-top:1px dashed var(--border-soft);
    font-family:var(--font-mono);font-size:9.5px;color:var(--faint);word-break:break-all;user-select:text;cursor:text}
  .tb-card .tb-c-copy{margin-left:6px;cursor:pointer;color:var(--bronze-dim);border:1px solid var(--border-soft);
    border-radius:4px;padding:0 4px;font-size:9.5px}
  .tb-card .tb-c-copy:hover{color:var(--accent-bright);border-color:var(--bronze)}
 /* usage 可疑徽标(克制:细边 + 警示色文字,不填充色块) */
  .tb-card .tb-c-head .tb-suspect{color:var(--warn);border:1px solid var(--border-soft);border-radius:4px;
    padding:0 4px;font-size:9.5px;letter-spacing:.3px}
 /* 2026-11 自愈:合成行标记(轨迹文件已落盘但 journal 未入账)+ 聊天流速览行 usage 可疑徽标 */
  .tb-card .tb-c-head .tb-synth,.tb-row .tb-synth{color:var(--bronze-dim);border:1px solid var(--border-soft);
    border-radius:4px;padding:0 4px;font-size:9.5px;letter-spacing:.3px}
  .llm-trace-line .lt-sus{flex:none;color:var(--warn);font-size:9.5px;letter-spacing:.3px}
 /* context.prune 独立卡(左竖线 + 灰标签的克制形态,不做彩色块) */
  .tb-card.tb-prune{background:transparent;border-left:2px solid var(--bronze-dim)}
  .tb-card.tb-prune .tb-c-head{cursor:default}
  .tb-card .tb-c-head .lbl{color:var(--faint);font-size:9.5px;letter-spacing:.5px}

 /* 服务重启降级横幅(视频 T1):停机窗口内不再裸 ERR_CONNECTION_REFUSED */
  #svcBanner{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:95;display:none;
    background:var(--window-bg,#141009);border:1px solid var(--bronze);border-top:none;border-radius:0 0 10px 10px;
    color:var(--bronze);font-size:11px;letter-spacing:1px;padding:6px 18px;box-shadow:0 6px 24px rgba(0,0,0,.4)}
  .mode-pill:hover{border-color:var(--bronze);color:var(--text)}
  .mode-pill.on{color:var(--accent-bright);border-color:var(--bronze)}
 /* 权限 pill 首同步前的「同步中」半透明态(用户用户反馈「每次询问和真实值对不上」):
 * 首帧 localStorage 种子可能是旧值,服务端 cfg.get 回包才落真值——这段窗口不许装成已确认。 */
  .mode-pill.sync{opacity:.5;border-style:dashed}
  #tabbar{display:flex;gap:4px;align-items:center;padding:0 2px 6px;flex-wrap:wrap}
  #tabbar:empty{display:none}
  .s-tab{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);border:1px solid var(--border-soft);
    border-radius:8px 8px 0 0;padding:4px 8px 4px 11px;cursor:pointer;max-width:180px;user-select:none;background:rgba(0,0,0,.2)}
  .s-tab:hover{color:var(--text)}
  .s-tab.on{color:var(--accent-bright);border-color:var(--bronze);background:rgba(201,143,69,.08)}
  .s-tab .st-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .s-tab .st-close{font-size:10px;color:var(--faint);padding:0 2px;border-radius:4px}
  .s-tab .st-close:hover{color:var(--red);background:rgba(224,138,122,.15)}
  .s-tab.draft-tab{padding:4px 10px;color:var(--bronze)}
  .stat-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:10px 0 14px;max-width:860px}
  .stat-card{border:1px solid var(--border-soft);border-radius:10px;background:var(--glass2);padding:10px 12px}
  .stat-card .sc-v{font-size:19px;color:var(--accent-bright);font-family:var(--mono)}
  .stat-card .sc-k{font-size:10px;color:var(--faint);margin-top:2px;letter-spacing:1px}
  .stat-h{font-size:11px;color:var(--bronze);margin:14px 0 6px;letter-spacing:1px}
  .hm-grid{display:grid;grid-template-columns:34px repeat(24,1fr);gap:2px;max-width:760px;font-size:9px}
  .hm-cell{height:13px;border-radius:2px;background:rgba(201,143,69,.08);min-width:8px}
  .hm-lab{color:var(--faint);font-size:9px;align-self:center}
  .stats-table{border-collapse:collapse;font-size:11px;max-width:860px;width:100%}
  .stats-table th{color:var(--faint);font-weight:400;text-align:left;padding:4px 10px;border-bottom:1px solid var(--border-soft);font-size:10px}
  .stats-table td{padding:4px 10px;color:var(--muted);border-bottom:1px solid rgba(200,143,69,.07);font-family:var(--mono)}
  .stats-table td:first-child{font-family:var(--sans);color:var(--text)}
  .exp-btn{font-size:10.5px;color:var(--bronze);background:transparent;border:1px solid var(--border-soft);border-radius:7px;padding:3px 12px;cursor:pointer;margin-right:6px}
  .exp-btn:hover{border-color:var(--bronze)}
  .auto-scope{display:flex;gap:6px;margin-bottom:6px}
  .auto-scope button{font-size:10.5px;color:var(--muted);background:transparent;border:1px solid var(--border-soft);border-radius:999px;padding:2px 12px;cursor:pointer}
  .auto-scope button.on{color:var(--accent-bright);border-color:var(--bronze)}
  .kbd-table{border-collapse:collapse;font-size:11.5px;max-width:640px}
  .kbd-table td{padding:5px 12px;border-bottom:1px solid rgba(200,143,69,.08);color:var(--muted)}
  .kbd-table td:first-child{font-family:var(--mono);color:var(--accent-bright);white-space:nowrap}

 /* ===== 终端 / 分组工具卡 / 办公模式 / 代码设置 / 预设与模型列表 ===== */
 /* 终端视图 */
  .term-body{flex:1;overflow-y:auto;background:var(--code-bg);border:1px solid var(--border-soft);border-radius:10px;
    padding:10px 14px;font-family:var(--font-mono);font-size:var(--code-fs,var(--fs-code));line-height:var(--lh-code);white-space:pre-wrap;word-break:break-word}
  .term-line{color:var(--text);white-space:pre-wrap}
  .term-line.dim{color:var(--faint)}
  .term-line.err{color:var(--red)}
  .term-line.cmd{color:var(--bronze)}
  .term-input-row{display:flex;gap:8px;align-items:center;padding:8px 2px 0}
  .term-prompt{color:var(--green);font-family:var(--font-mono)}
  .term-input-row input{flex:1;background:var(--input-bg);border:1px solid var(--border-soft);border-radius:8px;
    color:var(--text);font-family:var(--font-mono);font-size:var(--fs-code);padding:7px 12px;outline:none}
  .term-input-row input:focus{border-color:var(--bronze)}
 /* 分组工具卡(ZCode 分组搜索工具/终端命令/文件更改)
 分组卡与工具卡同型同规格(summary=tool 档 font-mono,组项=tool 档) */
  .tool-group{border:1px solid var(--border-soft);border-radius:9px;background:var(--sunken);margin:var(--gap-tool) 0;
    font-family:var(--font-mono);font-size:var(--fs-tool);line-height:var(--lh-tight)}
  .tool-group>summary{cursor:pointer;font-family:var(--font-mono);font-size:var(--fs-tool);line-height:var(--lh-tight);
    color:var(--muted);padding:6px 11px;list-style:none;user-select:none}
 /* 折叠指示改 CSS 描绘箭头(替代 ▸/▾ 字符形态),主题变量上色 */
  .tool-group>summary::before{content:'';display:inline-block;width:5px;height:5px;margin:0 6px 1px 1px;border-left:1.5px solid var(--bronze-dim);border-bottom:1.5px solid var(--bronze-dim);transform:rotate(-135deg);vertical-align:middle}
  .tool-group[open]>summary::before{transform:rotate(-45deg);margin-bottom:2px}
  .tool-group .tg-item{padding:2px 12px 6px;font-family:var(--font-mono);font-size:var(--fs-tool);line-height:var(--lh-tight)}
  .tool-group .tg-item .tg-name{color:var(--bronze);font-family:var(--font-mono)}
  .tool-group .tg-item .tg-args{color:var(--faint);font-size:var(--fs-code-sm);margin-left:6px}
 /* 办公模式:详情件收窄为摘要 */
  body.office .tool-card{display:none}
  body.office .think-card{display:none}
  body.office .office-chip{display:inline-block}
  .office-chip{display:none;font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--faint);border:1px dashed var(--border-soft);
    border-radius:6px;padding:1px 8px;margin:2px 4px 2px 0}
 /* 代码块设置(字号/行号/换行)——--code-fs 由设置页注入时优先,未设置回落排版令牌 --fs-code */
  pre.code, .fv-body, .tc-body{font-family:var(--font-mono);font-size:var(--code-fs,var(--fs-code));line-height:var(--lh-code)}
  body.nowrapcode pre.code{white-space:pre;overflow-x:auto}
  body.nowrapcode pre.code .cl{white-space:pre}
  pre.code .cl{display:block;white-space:pre-wrap}
  body.lineno pre.code{counter-reset:cln}
  body.lineno pre.code .cl{counter-increment:cln;padding-left:34px;position:relative}
  body.lineno pre.code .cl::before{content:counter(cln);position:absolute;left:0;width:26px;text-align:right;
    color:var(--faint);opacity:.7;font-size:.92em;user-select:none}
  body.lineno .fv-line .ln{min-width:34px;text-align:right}
 /* 代码预览双栏 */
  .codeprev-row{display:flex;gap:10px;max-width:760px}
  .codeprev{flex:1;border:1px solid var(--border-soft);border-radius:10px;padding:8px 10px;background:var(--glass2);min-width:0}
  .codeprev .cp-head{font-size:10px;color:var(--faint);margin-bottom:6px}
  .codeprev.on{border-color:var(--bronze);box-shadow:0 0 0 1px var(--bronze-glow)}
  .codeprev pre.code{margin:0;font-family:var(--font-mono);font-size:var(--fs-code);line-height:var(--lh-code)}
  #prev-light pre.code{background:#f6f8fa;color:#24292f;border-color:rgba(0,0,0,.1)}
  #prev-dark pre.code{background:#0d1117;color:#e6edf3;border-color:rgba(255,255,255,.08)}
 /* 供应商预设网格 */
  .preset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;max-width:760px;margin-bottom:8px}
  .preset-card{border:1px solid var(--border-soft);border-radius:9px;background:var(--glass2);padding:7px 10px;cursor:pointer;user-select:none}
  .preset-card:hover{border-color:var(--bronze)}
  .preset-card .pc-name{font-size:11.5px;color:var(--text)}
  .preset-card .pc-url{font-size:9.5px;color:var(--faint);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 /* 预设卡:服务商/套餐标记/模型数 */
  .preset-card .pc-top{display:flex;align-items:center;gap:6px;margin-bottom:2px}
  .preset-card .pc-top .pc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .preset-card .pc-tag{font-size:8.5px;letter-spacing:.5px;color:var(--bronze);border:1px solid var(--border-soft);border-radius:4px;padding:0 4px;white-space:nowrap}
  .preset-card .pc-tag.plan{color:var(--green);border-color:rgba(157,192,139,.4)}
  .preset-card .pc-tag.local{color:var(--warn);border-color:rgba(217,179,108,.4)}
  .preset-card .pc-models{font-size:9px;color:var(--faint);margin-top:2px}
  .prov-auth{font-size:9px;color:var(--bronze);border:1px solid var(--border-soft);border-radius:4px;padding:0 5px;white-space:nowrap}
  .prov-auth.plan{color:var(--green);border-color:rgba(157,192,139,.4)}
 /* 预设接入对话框:复用 uid-mask 壳,宽度/表单独立 */
  .pp-box{width:min(620px,calc(100vw - 36px));max-height:calc(100vh - 48px);overflow-y:auto}
  .pp-sub{font-size:11px;color:var(--muted);line-height:1.7;margin:-4px 0 12px}
  .pp-label{font-size:10px;letter-spacing:1px;color:var(--faint);margin:12px 0 5px}
  .pp-modes{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  @media (max-width:720px){.pp-modes{grid-template-columns:1fr}}
  .pp-mode{border:1px solid var(--border-soft);border-radius:9px;background:var(--glass2);padding:8px 10px;cursor:pointer}
  .pp-mode.on{border-color:var(--bronze);box-shadow:0 0 0 1px var(--accent-soft);background:var(--accent-soft)}
  .pp-mode.disabled{opacity:.55;cursor:default}
  .pp-mode .pm-top{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text)}
  .pp-mode .pm-radio{width:10px;height:10px;border-radius:50%;border:1px solid var(--border);flex-shrink:0}
  .pp-mode.on .pm-radio{border-color:var(--bronze);background:var(--bronze);box-shadow:0 0 0 2px var(--accent-soft)}
  .pp-mode .pm-url{font-size:9px;color:var(--faint);font-family:var(--mono);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pp-mode .pm-meta{font-size:9px;color:var(--faint);margin-top:2px}
  .pp-mode .pm-note{font-size:9px;color:var(--warn);margin-top:3px;line-height:1.5}
  .pp-url{font-size:10.5px;color:var(--muted);font-family:var(--mono);word-break:break-all;background:var(--sunken);border:1px solid var(--border-soft);border-radius:7px;padding:5px 8px}
  .pp-key{width:100%;font-size:12.5px;padding:8px 10px;margin-top:2px}
  .pp-hint{font-size:9.5px;color:var(--faint);line-height:1.6;margin-top:4px}
  .pp-warn{font-size:10px;color:var(--warn);line-height:1.6;margin-top:5px;display:none}
  .pp-warn.on{display:block}
  .pp-adv{margin-top:12px;border-top:1px solid var(--border-soft);padding-top:8px}
  .pp-adv summary{font-size:10.5px;color:var(--muted);cursor:pointer;letter-spacing:1px}
  .pp-adv .pp-adv-body{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
  .pp-adv .pp-adv-body label{font-size:9.5px;color:var(--faint);display:flex;flex-direction:column;gap:3px}
  .pp-adv .pp-adv-body label.wide{grid-column:1 / -1}
  .pp-adv input,.pp-adv textarea,.pp-adv select{width:100%;font-size:11px;padding:5px 7px}
  .pp-def{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-top:12px}
  .pp-status{font-size:10px;line-height:1.6;margin-top:8px;color:var(--faint);min-height:14px}
  .pp-status.bad{color:var(--red)}
  .pp-foot{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;padding-top:10px;border-top:1px solid var(--border-soft)}
  .pp-foot button{min-width:96px;padding:7px 0;font-size:12px;letter-spacing:1px;border-radius:9px}
 /* 模型列表 */
  .model-list{max-width:900px;max-height:520px;overflow-y:auto;padding-right:4px}
  .model-row{display:flex;align-items:center;gap:8px;border:1px solid var(--border-soft);border-radius:8px;
    background:var(--glass2);padding:5px 12px;margin-bottom:5px;font-size:11.5px}
  .model-row .mr-name{font-family:var(--mono);color:var(--text)}
  .model-row .mr-tag{font-size:9px;color:var(--green);border:1px solid rgba(157,192,139,.4);border-radius:4px;padding:0 5px}
  .model-row .mr-tag.r{color:var(--warn);border-color:rgba(217,179,108,.4)}
  .model-row .mr-off{color:var(--faint)}
  .model-row button{margin-left:auto;font-size:10px;color:var(--muted);border:1px solid var(--border-soft);border-radius:6px;padding:1px 9px;cursor:pointer;background:transparent}
  .model-row button:hover{border-color:var(--bronze);color:var(--text)}
 /* 管理面列表(子智能体/技能/命令/钩子/MCP/记忆) */
  .mgr-row{display:flex;align-items:center;gap:10px;border:1px solid var(--border-soft);border-radius:9px;
    background:var(--glass2);padding:8px 13px;margin-bottom:6px;max-width:820px}
  .mgr-row .m-name{font-size:12px;color:var(--text);font-family:var(--mono)}
  .mgr-row .m-src{font-size:9px;color:var(--faint);border:1px solid var(--border-soft);border-radius:4px;padding:0 6px}
  .mgr-row .m-desc{font-size:11px;color:var(--muted);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mgr-row .m-meta{font-size:10px;color:var(--faint);white-space:nowrap}
  .mgr-row button{font-size:10px;color:var(--muted);border:1px solid var(--border-soft);border-radius:6px;padding:2px 10px;cursor:pointer;background:transparent;white-space:nowrap}
 /* ── 运行看板(ref dashboard 融合;暖纸主题一致,纯 DOM/CSS 零图库) ── */
 /* 收编:#view-dash 不再是顶级 .view,是团队视图内的「看板」面板(switchView("dash")=团队看板子标签的内部路由) */
  #view-dash{display:none;flex-direction:column;gap:12px;min-width:0}
  #view-dash.on{display:flex}
  .vw-tabs{display:inline-flex;border:1px solid var(--border-soft);border-radius:8px;overflow:hidden;flex-shrink:0}
  .vw-tab{background:transparent;border:none;color:var(--muted);font-size:11px;padding:3px 14px;cursor:pointer;letter-spacing:2px}
  .vw-tab.on{background:var(--accent-soft);color:var(--bronze)}
  .vw-tab:hover{color:var(--text)}
  #view-team.tab-dash .team-only{display:none}
  #view-team:not(.tab-dash) .dash-only{display:none}
 /* fixD5:Issue 看板子标签(团队视图第三子页;issue-only 控件随标签切换,与 team-only/dash-only 同机制) */
  #view-team.tab-issues .team-only{display:none}
  #view-team.tab-issues .dash-only{display:none}
  #view-team:not(.tab-issues) .issue-only{display:none}
 /* super IDE 三栏布局:活动栏(56px)/侧栏(var(--superSb,280px))/中栏(1fr);聊天窗右缘叠层。
 全部新类前缀 spide-* 且包在 #view-super 作用域内(既有 panel CSS 全局作用域,防污染其它视图);
 窄屏退化:<1201px 聊天窗叠层阴影、<900px 侧栏塌折(类驱动,不动 --superSb)。 */
  #superIdeWrap{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:56px var(--superSb,280px) minmax(420px,1fr);position:relative;padding-right:var(--superChatW,360px)}
 /* 左栏宽度拖拽手柄:绝对定位在 56px 活动栏 + --superSb 边界上 */
  .spide-grip{position:absolute;top:0;bottom:0;left:calc(56px + var(--superSb,280px) - 3px);width:6px;cursor:col-resize;z-index:6;background:transparent}
  .spide-grip:hover{background:var(--bronze,#c98f45);opacity:.35}
  .spide-act{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0;border-right:1px solid var(--border-soft,rgba(201,143,69,.18))}
  .spide-actbtn{position:relative;width:38px;height:38px;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--muted,#a08e78);font-size:15px;cursor:pointer}
  .spide-actbtn:hover{border-color:var(--border-soft,rgba(201,143,69,.3));color:var(--text,#ece1d1)}
  .spide-actbtn.on{background:var(--bubble-a,rgba(201,143,69,.14));border-color:var(--bronze,#c98f45);color:var(--accent-bright,#e8b978)}
  .spide-actbtn .spide-badge{position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;line-height:15px;border-radius:999px;background:var(--red,#e08a7a);color:var(--on-accent,#1c1108);font-size:9px;font-weight:700;text-align:center;padding:0 3px;display:none;box-shadow:0 0 0 2px var(--bg,#060403)}
  .spide-actbtn .spide-badge.on{display:block}
  .spide-side{display:flex;flex-direction:column;min-height:0;min-width:0;border-right:1px solid var(--border-soft,rgba(201,143,69,.18));overflow:hidden}
  .spide-side-zone{display:none;flex-direction:column;min-height:0;flex:1 1 auto;padding:8px;gap:6px}
  #view-super.spide-zone-task .spide-side-zone#superSbTask,
  #view-super.spide-zone-dream .spide-side-zone#superSbDream{display:flex}
  #view-super.spide-side-folded .spide-side{display:none}
  .spide-side-h{font-size:10.5px;letter-spacing:1px;color:var(--faint,#7d6c58);display:flex;align-items:center;gap:6px;flex:0 0 auto}
  .spide-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px}
  .spide-empty{color:var(--faint,#7d6c58);font-size:11px;line-height:1.6}
  .spide-item{border:1px solid var(--border-soft,rgba(201,143,69,.2));border-radius:9px;padding:6px 9px;background:rgba(255,255,255,.02);font-size:12px;line-height:1.5;cursor:pointer;display:flex;align-items:center;gap:6px;min-width:0}
  .spide-item:hover{border-color:var(--bronze,#c98f45)}
 /* 待办区(侧栏):复用看板 .sup-row,窄栏下按钮更紧凑 */
  #superSbInbox .sup-row{padding:6px 8px}
  #superSbInbox .sup-row-h{flex-wrap:wrap;gap:4px}
  #superSbInbox .sup-acts{gap:4px;margin-top:4px}
  #superSbInbox .sup-btn{font-size:10px;padding:2px 7px}
  #superSbInbox .sup-sum{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .spide-item.on{border-color:var(--bronze,#c98f45);background:var(--bubble-a,rgba(201,143,69,.1))}
  .spide-item .sup-it{font-size:11.5px}
  .spide-main{display:flex;flex-direction:column;min-height:0;min-width:0;position:relative}
  .spide-welcome{flex:1 1 auto;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--faint,#7d6c58);font-size:12px;line-height:2}
  .spide-doc{display:none;flex-direction:column;gap:10px;min-height:0;overflow-y:auto;padding:12px;flex:1 1 auto}
  #view-super.spide-open-task .spide-doc#superMainTask,
  #view-super.spide-open-dream .spide-doc#superMainDream,
  #view-super:not(.spide-open-task):not(.spide-open-dream):not(.spide-open-health) .spide-welcome{display:flex}
  #view-super.spide-open-task .spide-welcome,
  #view-super.spide-open-dream .spide-welcome,
  #view-super.spide-open-task .spide-doc#superMainDream,
  #view-super.spide-open-dream .spide-doc#superMainTask{display:none}
  .spide-doc-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--text,#ece1d1);font-weight:600}
 /* 任务详情:Super → Coding Agent → 结果回执 的协作链(主题变量取色,七套主题跟随) */
  .spide-doc-md{font-size:12px;line-height:1.7;color:var(--text);max-height:420px;overflow-y:auto;background:var(--input-bg);border:1px solid var(--border-soft);border-radius:9px;padding:8px 11px;min-width:0}
  .spide-doc-md>:first-child{margin-top:0}
  .spide-doc-md>:last-child{margin-bottom:0}
  .spide-rel{border:1px solid var(--border-soft);border-radius:12px;background:var(--surf-card,rgba(0,0,0,.14));padding:12px;display:flex;flex-direction:column;gap:10px;flex:0 0 auto}
  .spide-rel-chain{display:flex;align-items:stretch;gap:6px;flex-wrap:wrap}
  .rel-node{display:flex;align-items:center;gap:7px;border:1px solid var(--border-soft);border-radius:9px;padding:6px 8px;background:var(--glass2,rgba(28,18,10,.55));min-width:0;flex:1 1 0}
  .rel-node b{width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;color:var(--on-accent,#1c1108);background:var(--bronze,#c98f45);flex:0 0 auto}
  .rel-node>span{min-width:0;display:block}
  .rel-node .rn-t{font-size:11px;color:var(--text);font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rel-node .rn-s{font-size:9px;color:var(--faint);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rel-node.code b{background:var(--accent2,#e08a7a)}
  .rel-node.ret b{background:var(--green,#9dc08b);color:var(--on-accent,#1c1108)}
  .rel-node.ret.t-bad b{background:var(--red,#e08a7a)}
  .rel-node.ret.t-run b{background:var(--warn,#d9b36c)}
  .rel-link{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:var(--faint);font-size:9px;min-width:26px;flex:0 0 26px}
  .rel-link .rel-line{width:100%;height:1px;background:linear-gradient(90deg,var(--border-soft),var(--bronze))}
  .rel-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--faint)}
  .rel-meta b{color:var(--muted);font-weight:500;font-family:var(--mono,ui-monospace,monospace)}
  .rel-timeline{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:9.5px;color:var(--faint)}
  .rel-step{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border-soft);border-radius:999px;padding:1px 7px;background:var(--input-bg)}
  .rel-step b{color:var(--text);font-weight:600}
  .rel-step span{font-family:var(--mono,ui-monospace,monospace);font-size:9px;color:var(--faint)}
  .rel-step.s-ok b{color:var(--green,#9dc08b)}.rel-step.s-bad b{color:var(--red,#e08a7a)}.rel-step.s-run b{color:var(--warn,#d9b36c)}.rel-step.s-idle b{color:var(--muted)}
  .rel-step+.rel-step::before{content:"→";color:var(--bronze,#c98f45);margin-right:2px}
  .rel-note{font-size:10px;line-height:1.55;color:var(--faint);border-top:1px dashed var(--border-soft);padding-top:7px}
  .spide-back{border:1px solid var(--border-soft,rgba(201,143,69,.3));background:transparent;color:var(--muted,#a08e78);font:inherit;font-size:11px;padding:2px 9px;border-radius:6px;cursor:pointer}
  .spide-back:hover{border-color:var(--bronze,#c98f45)}
  #rsiRunAllWrap{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted);flex:0 0 auto}
  #rsiRunAll[disabled]{opacity:.5;cursor:not-allowed}
  #rsiHead{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto}
 /* RSI-SELF-DRIVE:自动周期条(主题变量取色,浅/深七套主题自动跟随) */
 /* 对比度经验证:--muted 在 olive 3.87:1(10.5px 小字低于 AA 4.5)→ 行文字统一用 --text
 (七主题实测 7.5~17.9),层次交给字重/字号,不靠降低亮度。 */
  .rsi-sched{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:10.5px;color:var(--text);border:1px solid var(--border-soft);border-radius:9px;background:var(--surf-card,rgba(0,0,0,.14));padding:6px 9px;flex:0 0 auto}
  .rsi-sched b{color:var(--text);font-weight:600;font-size:11px}
  .rsi-sched .ss-dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:0 0 auto}
  .rsi-sched .ss-dot.ok{background:var(--green,#7bb37b)}
  .rsi-sched .ss-dot.warn{background:var(--warn,#d9b36c)}
  .rsi-sched .vw-act{color:var(--text);font-size:10.5px}
  .rsi-sched .vw-act:hover{border-color:var(--bronze);color:var(--text)}
  .rsi-sched .ss-toggle{font-size:10.5px;padding:2px 8px}
  .rsi-sched .ss-toggle[disabled]{opacity:.5;cursor:not-allowed}
  .rsi-sched .ss-int{font:inherit;font-size:10.5px;color:var(--text);background:var(--input-bg,rgba(0,0,0,.2));border:1px solid var(--input-border,var(--border-soft));border-radius:6px;padding:2px 4px}
  .rsi-sched .ss-meta{white-space:nowrap}
  .rsi-sched .ss-badge{font-size:10px;border-radius:999px;padding:1px 7px;border:1px solid var(--border-soft);color:var(--text)}
  .rsi-sched .ss-badge.warn{color:var(--warn,#d9b36c);border-color:var(--warn,#d9b36c)}
  .rsi-run-warn{color:var(--warn,#d9b36c)}
  #rsiCards{display:flex;flex-direction:column;gap:10px;align-items:stretch;min-height:0}
  #rsiStream{flex:0 0 auto;max-height:40%}
 /* 聊天窗(右栏):常驻不可折叠;绝对定位叠在 superIdeWrap 右缘,padding-right 让位;左缘拖拽手柄改 --superChatW */
 /* 实底聊天窗:--surf-card 各主题均带透明度(α.03-.14),
 叠在画布/内容上=透卡片观感。改为不透明 --bg(全主题实色 hex)打底,再薄染一层 surf 保持卡感;
 background-color 放最底层,渐变染层在上。 */
  .spide-chat{position:absolute;top:0;right:0;bottom:0;width:var(--superChatW,360px);display:flex;flex-direction:column;border-left:1px solid var(--border-soft,rgba(201,143,69,.18));background-color:var(--bg,#060403);background-image:linear-gradient(0deg,var(--surf-card,rgba(0,0,0,.14)),var(--surf-card,rgba(0,0,0,.14)));z-index:5}
 /* 聊天窗头部:身份 + 实时状态 + 回最新(主题变量全部取自七套主题,不写死黑白) */
  .spide-chat-h{flex:0 0 auto;display:flex;align-items:center;gap:9px;padding:8px 11px;border-bottom:1px solid var(--border-soft);background:linear-gradient(90deg,var(--bubble-a,rgba(201,143,69,.10)),var(--glass2,rgba(28,18,10,.55)) 55%)}
  .sch-ava{width:27px;height:27px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:var(--on-accent,#1c1108);background:linear-gradient(135deg,var(--grad-a,#d8a354),var(--grad-b,#a96f2b));flex:0 0 auto;box-shadow:inset 0 0 0 1px var(--bronze-glow,rgba(201,143,69,.45))}
  .sch-id{min-width:0;flex:1 1 auto}
  .sch-name{font-family:var(--serif);font-size:13px;font-weight:600;letter-spacing:1px;color:var(--text);display:flex;align-items:center;gap:7px;min-width:0}
  .sch-state{font-size:9.5px;font-weight:500;color:var(--muted);border:1px solid var(--border-soft);border-radius:999px;padding:0 6px;flex:0 0 auto}
  .sch-state.busy{color:var(--accent-bright);border-color:var(--bronze)}
  .sch-state.wait{color:var(--text);border-color:var(--red,#e08a7a)}
  .sch-state.todo{color:var(--text);border-color:var(--warn,#d9b36c)}
  .sch-state[data-zone="inbox"]{cursor:pointer}
  .sch-state[data-zone="inbox"]:hover{background:var(--hover-bg,rgba(255,255,255,.06))}
  .sch-sub{font-size:9.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
  .sch-latest{flex:0 0 auto;border:1px solid var(--border-soft);background:var(--input-bg);color:var(--muted);font:inherit;font-size:10px;padding:2px 8px;border-radius:999px;cursor:pointer;display:none}
  .sch-latest.on{display:inline-block}
  .sch-latest:hover{border-color:var(--bronze);color:var(--text)}
 /* 实时指挥状态条:研判/调度/委托 + 当前动作 + 秒表;仅运行期出现,底部流光 */
  .sup-runbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border-soft,rgba(201,143,69,.18));background:linear-gradient(90deg,transparent,var(--bubble-a,rgba(201,143,69,.10)),transparent);font-size:10.5px;color:var(--muted);position:relative;overflow:hidden}
  .sup-runbar .sr-dot{width:6px;height:6px;border-radius:50%;background:var(--bronze,#c98f45);box-shadow:0 0 8px var(--bronze-glow,rgba(201,143,69,.45));animation:srPulse 1.4s ease-in-out infinite;flex:0 0 auto}
  .sup-runbar .sr-phase{color:var(--bronze,#c98f45);font-weight:600;letter-spacing:1px;white-space:nowrap;flex:0 0 auto}
  .sup-runbar .sr-act{color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
  .sup-runbar .sr-steps{display:flex;align-items:center;gap:4px;overflow:hidden;flex:0 1 auto;max-width:46%}
  .sup-runbar .sr-step{font-size:9px;color:var(--faint);border:1px solid var(--border-soft);border-radius:999px;padding:0 5px;white-space:nowrap;flex:0 0 auto;background:var(--input-bg)}
  .sup-runbar .sr-step.on{color:var(--muted);border-color:var(--border-soft)}
  .sup-runbar .sr-time{margin-left:auto;font-family:var(--mono,ui-monospace,monospace);font-size:9.5px;color:var(--faint);font-variant-numeric:tabular-nums;flex:0 0 auto}
  .sup-runbar::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,transparent,var(--bronze,#c98f45),transparent);background-size:40% 100%;background-repeat:no-repeat;opacity:.6;animation:srShimmer 2.2s linear infinite}
  @keyframes srPulse{0%,100%{opacity:.45}50%{opacity:1}}
  @keyframes srShimmer{0%{background-position:-40% 0}100%{background-position:140% 0}}
  .spide-chat-grip{position:absolute;top:0;bottom:0;left:-3px;width:6px;cursor:col-resize;z-index:7;background:transparent}
  .spide-chat-grip:hover{background:var(--bronze,#c98f45);opacity:.35}
  body.super-resizing{cursor:col-resize;user-select:none}
 /* ── 健康一屏(spide-health- / spide-mcard / spide-brief / spide-fold;全部包 #view-super,零新硬编码主题色)── */
  #view-super.spide-open-health .spide-doc#superMainHealth{display:flex}
  #view-super.spide-open-health .spide-welcome,
  #view-super.spide-open-health .spide-doc#superMainTask,
  #view-super.spide-open-health .spide-doc#superMainDream,
  #view-super.spide-zone-health .spide-side-zone#superSbTask,
  #view-super.spide-zone-health .spide-side-zone#superSbDream{display:none}
  #view-super.spide-zone-health .spide-side-zone#superSbHealth{display:flex}
  #view-super.spide-zone-inbox .spide-side-zone#superSbInbox{display:flex}
  .spide-health-top{border:1px solid var(--border-soft,rgba(201,143,69,.25));border-radius:12px;background:rgba(255,255,255,.02);padding:14px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;flex:0 0 auto}
  .spide-health-verdict{display:flex;align-items:baseline;gap:7px;flex:0 0 auto}
  .spide-health-verdict b{font-size:30px;font-weight:700;line-height:1;letter-spacing:.5px}
  .spide-health-verdict span{font-size:11px;color:var(--muted,#a08e78);white-space:nowrap}
  .spide-health-verdict.s-bad b{color:var(--red,#f85149)}.spide-health-verdict.s-warn b{color:var(--warn,#d29922)}.spide-health-verdict.s-ok b{color:var(--green,#3fb950)}.spide-health-verdict.s-idle b{color:var(--muted,#6b7280)}
 /* Coding Agent 结果流(中栏):分组=机制体检 / 派发任务 / 其他任务动态(折叠);行=人话摘要,不是原始事件串 */
  #superResultFeed{flex:0 0 auto;max-height:256px;overflow-y:auto;border:1px solid var(--border-soft,rgba(201,143,69,.22));border-radius:10px;background:rgba(255,255,255,.02);padding:9px 11px;display:flex;flex-direction:column;gap:7px}
  #superResultFeed .srf-h{font-size:10.5px;letter-spacing:1px;color:var(--faint,#7d6c58);display:flex;align-items:center;gap:8px;flex:0 0 auto}
  #superResultFeed .srf-ht{font-size:11px;font-weight:600;letter-spacing:2px;color:var(--bronze,#c98f45)}
  #superResultFeed .srf-sub{font-size:9.5px;color:var(--faint,#7d6c58);margin-left:auto}
  #superResultFeed .srf-group{display:flex;flex-direction:column;gap:5px;min-width:0}
  #superResultFeed .srf-gh{font-size:10px;letter-spacing:.5px;color:var(--muted,#a08e78);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  #superResultFeed .srf-gh b{color:var(--bronze,#c98f45);font-weight:600}
  #superResultFeed .srf-gh span{font-size:9.5px;color:var(--faint,#7d6c58)}
  #superResultFeed .srf-card{border:1px solid var(--border-soft,rgba(201,143,69,.18));border-radius:8px;background:rgba(255,255,255,.025);padding:7px 9px;display:flex;flex-direction:column;gap:3px;min-width:0}
  #superResultFeed .srf-card[data-idedetail]{cursor:pointer}
  #superResultFeed .srf-card:hover{background:rgba(201,143,69,.09);border-color:rgba(201,143,69,.4)}
  #superResultFeed .srf-card-h{display:flex;align-items:center;gap:7px;min-width:0}
  #superResultFeed .srf-ct{font-size:12px;font-weight:600;color:var(--text,#ece1d1);flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #superResultFeed .srf-meta{margin-left:auto;font-size:9.5px;color:var(--faint,#7d6c58);flex:0 0 auto;white-space:nowrap}
 /* 派发卡时间(已运行/用时):与 srf-meta 同字号、靠右不压缩标题;运行中描铜色,终态回灰 */
  #superResultFeed .srf-dur{font-size:9.5px;color:var(--faint,#7d6c58);flex:0 0 auto;white-space:nowrap;font-variant-numeric:tabular-nums}
  #superResultFeed .srf-dur.run{color:var(--bronze,#c98f45)}
  #superResultFeed .srf-dur.ok{color:var(--muted,#a4977f)}
  #superResultFeed .srf-cs{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:1.5;color:var(--text,#ece1d1);min-width:0}
  #superResultFeed .srf-chip{flex:0 0 auto;font-size:9.5px;color:var(--bronze,#c98f45);border:1px solid var(--border-soft,rgba(201,143,69,.3));border-radius:5px;padding:0 4px;white-space:nowrap}
  #superResultFeed .srf-chip.rel{color:var(--accent2,#e08a7a);border-color:var(--border-soft,rgba(201,143,69,.3))}
  #superResultFeed .srf-lead{min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  #superResultFeed .srf-cd{font-size:10.5px;line-height:1.45;color:var(--muted,#a08e78);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
  #superResultFeed .srf-row{display:flex;align-items:baseline;gap:7px;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.02);min-width:0}
  #superResultFeed .srf-row[data-idedetail]{cursor:pointer}
  #superResultFeed .srf-row:hover{background:rgba(201,143,69,.10)}
  #superResultFeed .srf-t{font-size:11px;font-weight:600;color:var(--text,#ece1d1);flex:0 0 auto;min-width:42px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%}
  #superResultFeed .srf-s{font-size:10.5px;color:var(--muted,#a08e78);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #superResultFeed .srf-m{font-size:9.5px;color:var(--faint,#7d6c58);flex:0 0 auto;margin-left:auto}
  #superResultFeed .sup-badge{flex:0 0 auto}
  #superResultFeed .srf-other{border-top:1px dashed var(--border-soft,rgba(201,143,69,.2));padding-top:6px}
  #superResultFeed .srf-other>summary{cursor:pointer;font-size:10px;color:var(--muted,#a08e78);list-style:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  #superResultFeed .srf-other>summary::-webkit-details-marker{display:none}
  #superResultFeed .srf-other>summary::before{content:"▸";color:var(--bronze,#c98f45);font-size:9px}
  #superResultFeed .srf-other[open]>summary::before{content:"▾"}
  #superResultFeed .srf-other>summary b{color:var(--bronze,#c98f45);font-weight:600}
  #superResultFeed .srf-other>summary span{font-size:9.5px;color:var(--faint,#7d6c58)}
  #superResultFeed .srf-more{font-size:9.5px;color:var(--faint,#7d6c58);padding:3px 0}
  #superResultFeed .srf-other .srf-row{margin-top:4px}
  .spide-health-score{font-size:28px;font-weight:700;line-height:1;letter-spacing:.5px;flex:0 0 auto}
  .spide-health-score.s-ok{color:#3fb950}.spide-health-score.s-warn{color:#d29922}.spide-health-score.s-bad{color:#f85149}.spide-health-score.s-idle{color:#6b7280}
  .spide-health-bar{height:6px;border-radius:3px;overflow:hidden;background:rgba(0,0,0,.3);flex:1 1 120px;min-width:90px}
  .spide-health-bar i{display:block;height:100%;border-radius:3px}
  .spide-health-bar i.s-ok{background:#3fb950}.spide-health-bar i.s-warn{background:#d29922}.spide-health-bar i.s-bad{background:#f85149}.spide-health-bar i.s-idle{background:#6b7280}
  .spide-health-counts{display:flex;gap:10px;font-size:11px;color:var(--muted,#a08e78);flex:0 0 auto}
  .spide-health-counts b{font-weight:600}
  .spide-health-counts .c-ok b{color:var(--green,#3fb950)}.spide-health-counts .c-warn b{color:var(--warn,#d29922)}.spide-health-counts .c-bad b{color:var(--red,#f85149)}.spide-health-counts .c-idle b{color:var(--muted,#6b7280)}
  .spide-health-dream{font-size:11px;color:var(--muted,#a08e78);flex:0 0 auto}
  .spide-health-findings{display:flex;flex-direction:column;gap:5px;flex:1 1 260px;min-width:200px}
  .spide-health-f{display:flex;gap:6px;font-size:11.5px;line-height:1.5;align-items:baseline}
  .spide-health-f .fdot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;position:relative;top:-1px}
  .spide-health-f.t-bad .fdot{background:#f85149}.spide-health-f.t-warn .fdot{background:#d29922}.spide-health-f.t-ok .fdot{background:#3fb950}.spide-health-f.t-idle .fdot{background:#6b7280}
  .spide-health-f .ft{color:var(--text,#ece1d1);font-weight:600;flex:0 0 auto}
  .spide-health-f .fs{color:var(--muted,#a08e78);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .spide-health-f[data-health-mech]{cursor:pointer;border-radius:5px;padding:1px 3px;margin:-1px -3px}
  .spide-health-f[data-health-mech]:hover{background:rgba(201,143,69,.10)}
  .spide-health-pending{font-size:11px;color:var(--muted,#a08e78);flex:0 0 auto}
  .spide-health-legend{flex:1 1 100%;font-size:10px;line-height:1.5;color:var(--muted,#a08e78)}
  #superHealthGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;flex:1 1 auto;min-height:0;overflow-y:auto;padding:2px;align-content:start;align-items:start;grid-auto-rows:max-content}
  .spide-mcard{border:1px solid var(--border-soft,rgba(201,143,69,.25));border-radius:10px;background:rgba(255,255,255,.02);padding:12px;min-height:96px;cursor:pointer;display:flex;flex-direction:column;gap:6px;min-width:0;transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease}
  .spide-mcard:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(0,0,0,.35);border-color:var(--bronze,#c98f45)}
  .spide-mcard-h{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:500;color:var(--muted,#a08e78);min-width:0;flex:0 0 auto}
  .spide-mcard-h .mname{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .spide-mcard-h .mlabel{font-size:9.5px;color:var(--faint,#7d6c58);border:1px solid var(--border-soft,rgba(201,143,69,.25));border-radius:5px;padding:0 5px;flex:0 0 auto}
  .spide-mcard-h .mlabel.m-ok{color:var(--green,#5ec269);border-color:var(--border-soft)}
  .spide-mcard-h .mlabel.m-warn{color:var(--warn,#d9a83a);border-color:var(--border-soft)}
  .spide-mcard-h .mlabel.m-bad{color:var(--red,#f0665c);border-color:var(--border-soft)}
  .spide-mcard-purpose{font-size:10px;line-height:1.45;color:var(--muted,#7d6c58);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;flex:0 0 auto}
  .spide-mcard-lead{font-size:14.5px;font-weight:600;line-height:1.45;color:var(--text,#ece1d1);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-height:2.9em;flex:0 0 auto}
  .spide-mcard-lead.l-ok{color:var(--green,#5ec269)}.spide-mcard-lead.l-warn{color:var(--warn,#d9a83a)}.spide-mcard-lead.l-bad{color:var(--red,#f0665c)}.spide-mcard-lead.l-idle{color:var(--muted,#a08e78);font-weight:500}
  .spide-mcard-sub{font-size:10.5px;line-height:1.45;color:var(--faint,#7d6c58);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-height:2.9em;flex:0 0 auto}
  .spide-mcard-meta{font-size:10px;color:var(--faint,#7d6c58);margin-top:auto;flex:0 0 auto;line-height:1.4}
  .spide-mcard-kv{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--faint,#7d6c58);flex:0 0 auto}
  .spide-mcard-kv b{color:var(--muted,#a08e78);font-weight:600}
  .spide-mcard-cost{font-size:10.5px;color:var(--faint,#7d6c58);margin-top:auto;flex:0 0 auto}
 /* 体检卡状态灯(D4:10px 圆点;ok/warn/bad/未跑 四色) */
  .spide-mcard .mdot{width:10px;height:10px;border-radius:50%;flex:0 0 auto}
  .spide-mcard .mdot.s-ok{background:#3fb950}.spide-mcard .mdot.s-warn{background:#d29922}.spide-mcard .mdot.s-bad{background:#f85149}.spide-mcard .mdot.s-idle{background:#6b7280}
  .spide-health-empty{border:1px dashed var(--border-soft,rgba(201,143,69,.25));border-radius:10px;padding:28px 18px;display:flex;align-items:center;justify-content:center;gap:12px;color:var(--muted,#a08e78);font-size:13px;line-height:1.7;flex-wrap:wrap}
  .spide-health-loading{color:var(--muted,#a08e78);animation:spide-health-pulse 1.4s ease-in-out infinite}
  @keyframes spide-health-pulse{0%,100%{opacity:.55}50%{opacity:1}}
  @media (max-width:900px){#superHealthGrid{grid-template-columns:repeat(2,1fr)}}
  @media (max-width:600px){#superHealthGrid{grid-template-columns:1fr}}
 /* 医生的话引言块(详情页顶部)+ 原始 items 折叠 */
  .spide-brief{border-left:3px solid var(--bronze,#c98f45);background:rgba(201,143,69,.07);border-radius:0 10px 10px 0;padding:10px 14px;font-size:14px;line-height:1.6;color:var(--text,#ece1d1);flex:0 0 auto}
  .spide-brief-h{font-size:10.5px;letter-spacing:1px;color:var(--bronze,#c98f45);font-weight:600;margin-bottom:6px}
  .spide-fold{border:1px solid var(--border-soft,rgba(201,143,69,.2));border-radius:10px;flex:0 0 auto}
  .spide-fold>summary{cursor:pointer;font-size:11.5px;color:var(--muted,#a08e78);padding:7px 12px;user-select:none}
  .spide-fold>summary:hover{color:var(--bronze,#c98f45)}
  .spide-fold .spide-fold-body{padding:2px 12px 10px}
  .spide-fold[open]>summary{color:var(--bronze,#c98f45)}
  #superChatCol{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;overflow:hidden}
  #view-super .sup-chat-only{display:inline}
  @media (max-width:1200px){
    #superIdeWrap{padding-right:0}
    .spide-chat{box-shadow:-8px 0 24px rgba(0,0,0,.4)}
    .spide-grip,.spide-chat-grip{display:none}
  }
  @media (max-width:900px){
    #superIdeWrap{grid-template-columns:56px 0 minmax(0,1fr)}
    .spide-side{display:none}
  }
/* ── super 聊天窗:派发卡/做梦卡样式(暖纸主题变量复用) ────────────────── */
  .sup-dispatch{border:1px solid var(--border-soft);border-left:3px solid #1f6feb;border-radius:10px;background:var(--glass2);padding:8px 10px;cursor:pointer;display:flex;flex-direction:column;gap:4px}
  .sup-dispatch:hover{border-color:rgba(31,111,235,.5)}
  .sup-dispatch.st-done{border-left-color:#2e7d32}
  .sup-dispatch.st-failed{border-left-color:#b3261e}
  .sup-dispatch.st-running{border-left-color:#b26a00}
  .sup-dispatch-h{display:flex;align-items:center;gap:6px;font-size:11px}
  .sup-dispatch-f{font-size:10px;color:var(--faint)}
  .sup-dream{border:1px dashed var(--border-soft);border-left:3px solid #6b4fa1;border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;font-size:11px}
  .sup-dream.ph-start{border-left-color:#6b4fa1}
  .sup-dream.ph-done{border-left-color:#2e7d32}
  .sup-dream.ph-failed{border-left-color:#b3261e}
  .sup-dream-h{color:var(--text);font-weight:600}
  .sup-dream-cost{color:var(--muted);font-size:10.5px}
  #rsiHead{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  #rsiCards{display:flex;flex-direction:column;gap:10px;align-items:stretch;overflow-y:auto;min-height:0;padding-right:2px}
  .rsi-card{border:1px solid var(--border-soft);border-radius:10px;background:var(--glass2);padding:10px 12px;min-width:0;display:flex;flex-direction:column;gap:6px}
  .rsi-card-focus{border-color:var(--bronze,#c98f45)!important;box-shadow:0 0 0 1px var(--bronze,#c98f45) inset}
  .rsi-card-h{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text);letter-spacing:1px;flex-wrap:wrap}
  .rsi-card-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
  .rsi-run-state{overflow-wrap:anywhere}
  .rsi-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;background:#b26a00}
  .rsi-tone-ok .rsi-dot,.rsi-dot.rsi-tone-ok{background:#2e7d32}
  .rsi-tone-warn .rsi-dot,.rsi-dot.rsi-tone-warn{background:#b26a00}
  .rsi-tone-bad .rsi-dot,.rsi-dot.rsi-tone-bad{background:#b3261e}
 /* RSI-DASH-UX:未启用(无 store)是中性态,灰点;不得与红色异常同款 */
  .rsi-tone-idle .rsi-dot,.rsi-dot.rsi-tone-idle{background:#6b7280}
  .rsi-code{font-size:9.5px;color:var(--faint);word-break:break-all}
  .rsi-badge{margin-left:auto;font-size:9.5px;letter-spacing:0;padding:0 5px;border-radius:6px;border:1px solid var(--border-soft);color:var(--faint);white-space:nowrap}
  .rsi-badge-ok{color:#2e7d32;border-color:#2e7d32}
  .rsi-badge-warn{color:#b26a00;border-color:#b26a00}
  .rsi-badge-bad{color:#b3261e;border-color:#b3261e}
  .rsi-cost{border:1px dashed var(--border-soft);border-radius:8px;padding:5px 8px;min-width:0}
  .rsi-cost>summary{cursor:pointer;font-size:10px;color:var(--muted);list-style:none;user-select:none}
  .rsi-cost>summary::-webkit-details-marker{display:none}
  .rsi-cost>summary::before{content:"▸ ";color:var(--bronze,#c98f45)}
  .rsi-cost[open]>summary::before{content:"▾ "}
  .rsi-cost .rsi-items{padding-top:5px}
  .rsi-hint{font-size:9.5px;color:var(--faint);line-height:1.45;word-break:break-word}
  .rsi-kv{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:10px;color:var(--muted)}
  .rsi-kv b{color:var(--text);font-weight:500}
  .rsi-kv b.rsi-tone-ok{color:#2e7d32}
  .rsi-kv b.rsi-tone-warn{color:#b26a00}
  .rsi-kv b.rsi-tone-bad{color:#b3261e}
  .rsi-warn-line{font-size:9.5px;color:#b3261e;line-height:1.45;word-break:break-word}
  .rsi-empty{font-size:10.5px;color:var(--faint)}
 /* RSI 固定会话窗( RSI-SESSION):紧凑事件流,复用暖纸变量 */
  #rsiStream{display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0;border:1px solid var(--border-soft);border-radius:10px;background:var(--glass2);padding:8px 10px;overflow:hidden}
  #rsiStreamHead{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto}
  #rsiStreamHead b{color:var(--text)}
  #rsiStreamBody{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
  .rsi-ev{font-size:10.5px;line-height:1.5;color:var(--text);border-left:2px solid var(--border-soft);padding:1px 0 1px 7px;word-break:break-word}
  .rsi-ev-task{border-left-color:#2e7d32}
  .rsi-ev-task b{color:#2e7d32;font-weight:600;margin-right:4px}
  .rsi-ev-agent{border-left-color:#1f6feb}
  .rsi-ev-tool{border-left-color:#b26a00;color:var(--muted)}
  .rsi-ev-args{color:var(--faint);font-size:9.5px}
  .rsi-ev-res{border-left-color:#6b7280;color:var(--faint)}
  .rsi-ev-step{border-left-color:transparent;color:var(--faint);font-size:9.5px}
  .rsi-ev-warn{border-left-color:#b3261e;color:#b3261e}
  .rsi-ev-txt{white-space:pre-wrap}
 /* RSI-CTRL:每机制可开关/切驱动/运行,结果条目可改可删(暖纸主题变量复用,零图库,零内联事件) */
  .rsi-ctrl{display:flex;align-items:center;gap:4px;margin-left:6px;flex-wrap:wrap}
  .rsi-sw,.rsi-run,.rsi-item-act{font:inherit;font-size:9.5px;line-height:1.6;padding:0 6px;border-radius:6px;border:1px solid var(--border-soft);background:transparent;color:var(--muted);cursor:pointer;white-space:nowrap}
  .rsi-sw.on{color:#2e7d32;border-color:#2e7d32}
  .rsi-sw.off{color:var(--faint)}
  .rsi-sw:hover,.rsi-run:hover,.rsi-item-act:hover{border-color:var(--bronze);color:var(--bronze)}
  .rsi-run[disabled]{opacity:.55;cursor:default;border-color:var(--border-soft);color:var(--faint)}
  .rsi-drv{font:inherit;font-size:9.5px;padding:0 2px;border-radius:6px;border:1px solid var(--border-soft);background:transparent;color:var(--muted);cursor:pointer}
  .rsi-run-state{font-size:9.5px;color:var(--faint);white-space:nowrap}
  .rsi-run-err{font-size:9.5px;color:#b3261e;line-height:1.45;word-break:break-word}
  .rsi-card-off{opacity:.55}
  .rsi-items{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--border-soft);padding-top:6px;min-width:0}
  .rsi-hist{margin-top:4px}
  .rsi-hist>summary{cursor:pointer;font-size:9.5px;color:var(--muted);padding:2px 0}
  .rsi-hist-body{display:flex;flex-direction:column;gap:3px;margin-top:3px;opacity:.72}
  .rsi-hist-item{flex-direction:row;align-items:center;gap:6px}
  .rsi-cost-row{font-size:9.5px;color:var(--faint);line-height:1.45;word-break:break-all}
  .rsi-item{display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--text);min-width:0}
  .rsi-item-row{display:flex;align-items:center;gap:6px;min-width:0}
  .rsi-item-t{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 0 auto;max-width:58%}
  .rsi-item.exp .rsi-item-t{cursor:pointer}
  .rsi-item-arrow{color:var(--faint);font-style:normal;font-size:9px;margin-left:2px}
  .rsi-item-sum{color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
  .rsi-item-acts{margin-left:auto;display:flex;gap:4px;flex-shrink:0}
  .rsi-item-detail{display:none;font-size:9.5px;color:var(--muted);line-height:1.45;word-break:break-word;border-left:2px solid var(--border-soft);padding-left:6px}
  .rsi-item.exp .rsi-item-detail{display:block}
 /* 质量契约 v2:运行头质量徽标 + 条目四件套(证据/影响/建议);主题变量取色 */
  .rsi-q{font-size:9.5px;border:1px solid var(--border-soft);border-radius:999px;padding:0 6px;white-space:nowrap}
  .rsi-q-ok{color:var(--green,#7bb37b);border-color:var(--green,#7bb37b)}
  .rsi-q-warn{color:var(--warn,#d9b36c);border-color:var(--warn,#d9b36c)}
  .rsi-q-bad{color:var(--red,#e08a7a);border-color:var(--red,#e08a7a)}
  .rsi-q-line{display:flex;gap:5px;margin:1px 0}
  .rsi-q-line b{flex:0 0 auto;color:var(--text);font-weight:600}
  .rsi-q-line span{min-width:0;word-break:break-word;color:var(--text)}
  .rsi-q-detail{margin-top:2px;color:var(--muted)}
  .rsi-item.rsi-arm .rsi-item-act[data-act="del"]{color:#b3261e;border-color:#b3261e}
  .rsi-form{display:flex;flex-direction:column;gap:4px;min-width:0}
  .rsi-form input,.rsi-form textarea{width:100%;box-sizing:border-box;font:inherit;font-size:10px;color:var(--text);background:rgba(255,255,255,.03);border:1px solid var(--border-soft);border-radius:6px;padding:3px 6px;resize:vertical}
  .rsi-form-acts{display:flex;gap:4px;justify-content:flex-end}
  .issue-col{border:1px solid var(--border-soft);border-radius:12px;padding:8px;min-height:140px;background:rgba(255,255,255,.015)}
  .issue-col-h{font-size:10px;letter-spacing:1px;color:var(--faint);margin-bottom:6px}
  .issue-cards{display:flex;flex-direction:column;gap:8px;min-height:60px}
  .issue-card{border:1px solid var(--border-soft);border-radius:10px;padding:8px 10px;background:rgba(255,255,255,.03);display:flex;flex-direction:column;gap:4px;cursor:grab}
  .issue-card:hover{border-color:var(--bronze)}
  .dash-card{border:1px solid var(--border-soft);border-radius:10px;background:var(--glass2);padding:12px 14px;min-width:0}
  .dash-card-t{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:8px}
  .dash-big{font-size:26px;font-weight:600;letter-spacing:-1px;margin:6px 0 2px;color:var(--text)}
  .dash-sub{font-size:10px;color:var(--faint)}
  .dash-card-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
  .dash-bars{display:flex;align-items:flex-end;gap:3px;height:88px;margin:10px 0 6px}
  .dash-bar{flex:1;background:var(--bronze);opacity:.75;border-radius:2px 2px 0 0;min-height:2px}
  .dash-bar:hover{opacity:1}
  .dash-bar-toggle{margin-left:auto;display:flex;gap:4px}
  .dash-bar-toggle .vw-act{padding:0 8px;font-size:10px}
  .dash-bar-toggle .vw-act.on{border-color:var(--bronze);color:var(--bronze)}
  .dash-sec{border:1px solid var(--border-soft);border-radius:10px;overflow:hidden}
  .dash-sec-h{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px;padding:8px 4px}
  .dash-sec .dash-sec-h{padding:9px 13px;border-bottom:1px solid var(--border-soft);color:var(--text)}
  .dash-cnt{font-size:10px;color:var(--faint);border:1px solid var(--border-soft);border-radius:4px;padding:0 6px}
  .dash-scroll{overflow-x:auto}
  .dash-table{width:100%;border-collapse:collapse;font-size:11px;min-width:860px}
  .dash-table th{text-align:left;font-weight:400;font-size:9px;letter-spacing:.6px;color:var(--faint);padding:7px 12px;border-bottom:1px solid var(--border-soft)}
  .dash-table td{padding:9px 12px;border-bottom:1px solid var(--border-soft);vertical-align:top;color:var(--text)}
  .dash-table tr:last-child td{border-bottom:none}
  .dash-row{cursor:pointer}
  .dash-row:hover{background:var(--glass)}
  .dash-row.row-ended{opacity:.6}
  .dash-prompt{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dash-meta{font-size:10px;color:var(--faint);margin-top:2px}
  .dash-st-run{color:#7fae67}
  .dash-st-wait{color:var(--bronze)}
  .dash-st-err{color:#c96a5f}
  .dash-st-idle{color:var(--faint)}
  .dash-st-stop{color:var(--faint)}
  .dash-bad{color:#c96a5f}
  .dash-arc{font-size:9px;color:var(--bronze);border:1px solid var(--bronze);border-radius:4px;padding:0 4px;margin-left:4px}
  .dash-denials{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;color:var(--muted);padding:2px 4px}
  .dash-denial{border:1px solid var(--border-soft);border-radius:6px;padding:1px 8px;font-size:10px;color:#c96a5f}
  .dash-live{font-size:10px;color:var(--faint)}
  #dashDrawer{position:fixed;top:0;right:-460px;bottom:0;width:min(440px,92vw);background:var(--glass2);border-left:1px solid var(--border-soft);
    z-index:60;transition:right .18s ease-out;padding:16px 18px;overflow-y:auto;backdrop-filter:blur(6px)}
  #dashDrawer.open{right:0}
  .dash-d-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:12px;color:var(--muted)}
  .dash-d-title{font-size:15px;margin:4px 0 6px;color:var(--text);line-height:1.4}
  #dashDetailBody section{border-top:1px solid var(--border-soft);padding:10px 0}
  #dashDetailBody h4{margin:0 0 6px;font-size:11px;color:var(--muted);font-weight:400}
  #dashDetailBody p{margin:4px 0;font-size:12px;color:var(--text);line-height:1.6}
  .dash-md{white-space:pre-wrap;word-break:break-word;font-size:11px;color:var(--muted);max-height:260px;overflow-y:auto}
  .mgr-row button:hover{border-color:var(--bronze);color:var(--text)}
  .mgr-row button.danger:hover{border-color:var(--red);color:var(--red)}
  .mgr-head{font-size:10px;color:var(--faint);letter-spacing:2px;margin:12px 0 6px;text-transform:uppercase}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex-shrink:0}
  .dot.ok{background:var(--green)}
  .dot.bad{background:var(--red)}
  .dot.wait{background:var(--warn)}
  .mem-box{max-width:820px}
  .mem-box h4{font-size:11.5px;color:var(--bronze);margin:10px 0 5px;font-weight:400}
  .mem-box pre{font-family:var(--mono);font-size:11px;line-height:1.7;color:var(--muted);white-space:pre-wrap;
    border-left:2px solid var(--bronze-dim);padding-left:12px;max-height:260px;overflow-y:auto}

 /* 规划态(全量开发) */
  .plan-box{border:1px solid rgba(157,192,139,.3);border-radius:11px;background:rgba(157,192,139,.05);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
  .plan-box h5{font-size:11px;color:var(--green);font-weight:400;letter-spacing:1px}
  .plan-form{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .plan-form input,.plan-form select{background:var(--input-bg);border:1px solid var(--border-soft);border-radius:7px;color:var(--text);font-size:11px;padding:4px 8px;outline:none}
  .plan-form button{background:transparent;border:1px solid var(--border-soft);color:var(--green);border-radius:7px;font-size:10.5px;padding:3px 10px;cursor:pointer}
  .plan-item{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted);border:1px dashed var(--border-soft);border-radius:7px;padding:4px 9px}
  .plan-item .pi-x{cursor:pointer;color:var(--faint);margin-left:auto}
  .plan-item .pi-x:hover{color:var(--red)}
  .plan-apply{background:linear-gradient(90deg,var(--grad-a),var(--grad-b));color:var(--on-accent);border:none;border-radius:8px;font-size:11.5px;padding:5px 16px;cursor:pointer;font-weight:600}
  .plan-apply:hover{filter:brightness(1.08)}
  .git-line{font-size:10px;color:var(--faint);margin-top:2px}

 /* ===== 项目档案(架构图管线) ===== */
 /* 文件与函数钻取 */
  .ppf{margin-top:14px;border-top:1px solid var(--border-soft);padding-top:10px}
  .ppf-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .ppf-head input{background:var(--input-bg);border:1px solid var(--border-soft);border-radius:8px;color:var(--text);font-size:11px;padding:3px 10px;outline:none;width:200px}
  .ppf-hint{font-size:9.5px;color:var(--faint)}
  .ppf-body{display:flex;gap:12px;min-height:220px}
  .ppf-files{width:270px;max-height:340px;overflow-y:auto;border:1px solid var(--border-soft);border-radius:10px;padding:6px;flex:none}
  .ppf-fitem{font-family:var(--mono);font-size:10px;color:var(--muted);padding:3px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ppf-fitem:hover{background:rgba(201,143,69,.08);color:var(--text)}
  .ppf-fitem.on{background:rgba(201,143,69,.14);color:var(--accent-bright)}
  .ppf-fns{flex:1;max-height:340px;overflow-y:auto;border:1px solid var(--border-soft);border-radius:10px;padding:8px 10px}
  .ppf-fn{display:flex;align-items:baseline;gap:8px;font-family:var(--mono);font-size:11px;color:var(--text);padding:2px 4px;border-radius:6px;cursor:pointer}
  .ppf-fn:hover{background:rgba(201,143,69,.08)}
  .ppf-fn .ln{color:var(--faint);font-size:9.5px}
  .ppf-fn .kd{color:var(--bronze);font-size:9px}
 /* code2flow 分类徽标(三改):入=trunk 棕底/叶=leaf 绿底 */
  .kd2-trunk{background:#8a5a2a;color:#fff;border-radius:4px;padding:0 3px;font-weight:600}
  .kd2-leaf{background:#3a5a3a;color:#b8e0b8;border-radius:4px;padding:0 3px}
  .ppf-fn .ct{color:var(--faint);font-size:9.5px}
  .ppf-graphwrap{flex:1;min-width:0;border:1px solid var(--border-soft);border-radius:10px;padding:8px;display:flex;flex-direction:column}
  .ppf-ghead{display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--faint);letter-spacing:1px;margin-bottom:6px}
  .ppf-mermaid{flex:1;overflow:hidden;font-size:10px;position:relative;cursor:grab}
  .ppf-mermaid .gv{transform-origin:0 0}
  .ppf-mermaid svg{max-width:none}
  .proj-row .p-prof{font-size:11px;color:var(--faint);padding:0 2px;cursor:pointer;opacity:0;transition:opacity .12s}
  .proj-row:hover .p-prof{opacity:1}
  .proj-row .p-prof:hover{color:var(--bronze)}
  #view-project{gap:8px}
  .pp-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:0 0 4px}
  .pp-title{font-size:15px;color:var(--text)}
  .pp-state{font-size:10px;border:1px solid var(--border-soft);border-radius:4px;padding:0 6px;color:var(--muted)}
  .pp-state.done{color:var(--green);border-color:rgba(157,192,139,.4)}
  .pp-state.running{color:var(--warn);border-color:rgba(217,179,108,.4)}
  .pp-state.failed{color:var(--red)}
  .pp-bar{flex:1;min-width:120px;height:6px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}
  .pp-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--grad-a),var(--grad-b));transition:width .3s}
  .pp-pct{font-size:10.5px;color:var(--muted);font-family:var(--mono);white-space:nowrap}
 /* n9 会话作用域标注:档案吃的是「会话归属项目」还是回退的当前项目,卡头必须明示 */
  .pp-owner{font-size:10px;color:var(--faint);font-family:var(--mono);white-space:nowrap}
  .pp-owner b{color:var(--bronze);font-weight:600}
  .pp-owner .pp-own-warn{color:#e08a7a}
  .pp-main{display:flex;gap:14px;flex:1;min-height:0}
  .pp-graph{flex:1.6;min-width:0;overflow:auto;border:1px solid var(--border-soft);border-radius:11px;background:var(--sunken);padding:10px}
  .pp-side{flex:1;min-width:260px;max-width:420px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
  .pp-search input{width:100%;background:var(--input-bg);border:1px solid var(--border-soft);border-radius:8px;color:var(--text);font-size:12px;padding:6px 12px;outline:none}
  .pp-mods{display:flex;flex-direction:column;gap:4px}
  .pp-mod{border:1px solid var(--border-soft);border-radius:9px;background:var(--glass2);padding:7px 11px;cursor:pointer}
  .pp-mod:hover{border-color:var(--bronze)}
  .pp-mod.on{border-color:var(--bronze);background:rgba(201,143,69,.09)}
  .pp-mod .pm-n{font-size:12px;color:var(--text)}
  .pp-mod .pm-d{font-size:10px;color:var(--faint);margin-top:2px}
  .pp-mod .pm-new{font-size:9px;color:var(--green);border:1px solid rgba(157,192,139,.4);border-radius:4px;padding:0 4px;margin-left:6px}
  .pp-detail{border:1px solid var(--border-soft);border-radius:10px;background:var(--glass2);padding:10px 13px;font-size:11.5px;color:var(--muted);line-height:1.7}
  .pp-detail b{color:var(--text);font-weight:400}
  .pp-detail .kd{font-family:var(--mono);font-size:10.5px;color:var(--bronze)}
  .pp-ch{border:1px solid var(--border-soft);border-radius:9px;background:var(--glass2);padding:6px 11px;font-size:10.5px;color:var(--muted)}
  .pp-ch .pc-t{color:var(--text)}
  .pp-ch .pc-m{color:var(--bronze);font-family:var(--mono)}
 /* ===== 设计沉淀(done 板项目级索引)+ 反查角标 ===== */
  .arc-item{border:1px solid var(--border-soft);border-radius:9px;background:var(--glass2);padding:6px 11px;font-size:10.5px;color:var(--muted);cursor:pointer;margin-bottom:4px}
  .arc-item:hover{border-color:var(--bronze)}
  .arc-item .arc-t{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .arc-item .arc-m{display:flex;gap:8px;align-items:center;margin-top:2px;color:var(--faint);font-size:9.5px;flex-wrap:wrap}
  .arc-filter{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--bronze);padding:2px 0 6px}
  .arc-badge{background:rgba(201,143,69,.15);border:1px solid var(--bronze);color:var(--bronze);border-radius:8px;font-size:var(--fs-chip);padding:0 6px;cursor:pointer;flex:none;font-family:var(--font-mono)}
  .arc-badge:hover{background:var(--bronze);color:#1a140c}
 /* K:档案灯箱宿主是固定高内联块,画布与底部图例条(.cv-rail)按 flex 列分摊高度 */
  #arcCv{display:flex;flex-direction:column}
  #arcCv .bf-canvas{flex:1;min-height:0;height:auto}

 /* ===== 市场/浏览器/账号/引导/附件/远程 ===== */
  .mkt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;max-width:980px}
  .mkt-card{border:1px solid var(--border-soft);border-radius:11px;background:var(--glass2);padding:12px 14px;display:flex;flex-direction:column;gap:6px;min-height:0}
  .mkt-card.on{border-color:var(--bronze);box-shadow:0 0 0 1px var(--bronze-glow)}
  .mkt-head{display:flex;align-items:center;gap:8px}
  .mkt-icon{width:28px;height:28px;border-radius:6px;object-fit:contain;flex:none;background:var(--bg-soft,rgba(127,127,127,.08));display:inline-flex;align-items:center;justify-content:center}
  .mkt-icon-fb{font-size:13px;font-weight:600;color:var(--bronze)}
  .mkt-pkg{font-size:9px;color:var(--faint);font-family:var(--mono,monospace)}
  .mkt-name{font-size:13px;color:var(--text)}
  .mkt-ver{font-size:9px;color:var(--faint);border:1px solid var(--border-soft);border-radius:4px;padding:0 5px}
  .mkt-cat{font-size:9px;color:var(--bronze);border:1px solid var(--border-soft);border-radius:4px;padding:0 5px}
  .mkt-src{font-size:9px;border-radius:4px;padding:0 5px;border:1px solid var(--border-soft)}
  .mkt-src-official{color:#1a7f37;border-color:#1a7f3755}
  .mkt-src-builtin{color:var(--faint)}
  .mkt-src-user{color:var(--accent,#4a7dff)}
  .mkt-desc{font-size:11px;color:var(--muted);line-height:1.6;flex:1}
  .mkt-prov{font-size:10px;color:var(--faint)}
  .mkt-prov b{color:var(--muted);font-weight:400}
  .mkt-btns{display:flex;gap:6px;margin-top:4px}
  .mkt-btns button{font-size:10.5px;color:var(--bronze);background:transparent;border:1px solid var(--border-soft);border-radius:7px;padding:3px 12px;cursor:pointer}
  .mkt-btns button:hover{border-color:var(--bronze)}
  .mkt-btns button.danger{color:var(--red)}
 /* 内嵌浏览器 */
  #view-browser .br-bar{display:flex;gap:8px;align-items:center;padding:0 0 8px}
  #view-browser .br-bar input{flex:1;background:var(--input-bg);border:1px solid var(--border-soft);border-radius:8px;color:var(--text);font-size:12px;padding:6px 12px;outline:none}
  #view-browser iframe{flex:1;width:100%;border:1px solid var(--border-soft);border-radius:10px;background:#fff}
 /* 内置浏览器视图(browser-view.js 自建 .gbv-root;宿主只给空容器) */
  .gbv-host{flex:1;min-height:0;display:flex;overflow:hidden;position:relative}
  #view-browser #brLegacyBar[hidden],#view-browser #brFrame[hidden]{display:none}
  .br-note{font-size:10px;color:var(--faint);padding-top:6px}
 /* 账号/额度 */
  .quota-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;max-width:820px;margin:10px 0}
  .quota-card{border:1px solid var(--border-soft);border-radius:11px;background:var(--glass2);padding:12px 14px}
  .quota-card .qv{font-size:17px;color:var(--accent-bright);font-family:var(--mono)}
  .quota-card .qk{font-size:10px;color:var(--faint);margin-top:2px}
  .quota-card .qr{font-size:9.5px;color:var(--faint);margin-top:4px}
  .quota-bar{height:5px;border-radius:3px;background:rgba(255,255,255,.08);margin-top:8px;overflow:hidden}
  .quota-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--grad-a),var(--grad-b))}
  .quota-bar i.over{background:var(--red)}
  .id-badge{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-chip);color:var(--muted);border:1px solid var(--border-soft);border-radius:999px;padding:3px 12px;margin:4px 6px 4px 0}
  .id-badge b{color:var(--accent-bright);font-weight:400}
 /* 引导 */
  .guide-item{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border-soft);border-radius:10px;background:var(--glass2);padding:10px 14px;margin-bottom:7px;max-width:640px}
  .guide-item .g-ck{font-size:15px;width:20px;text-align:center}
  .guide-item.done .g-ck{color:var(--green)}
  .guide-item .g-t{font-size:12px;color:var(--text)}
  .guide-item .g-d{font-size:10.5px;color:var(--faint);margin-top:2px}
  #tourMask{position:fixed;inset:0;z-index:120;background:var(--overlay);display:none;align-items:center;justify-content:center}
  #tourMask.on{display:flex}
 /* 画布形态下导览避让画布中心:弹窗原本正压中央卡片区,用户看不到它指向的界面。
 改为贴底居中并让出 HUD(底部 10+30+14)与 PTT 悬浮件的高度。 */
  body.cv-shell #tourMask.on{align-items:flex-end;justify-content:center;padding-bottom:110px}
  .tour-box{max-width:420px;background:var(--window-bg);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
  .tour-box h4{font-size:14px;color:var(--accent-bright);margin-bottom:8px;font-weight:400}
  .tour-box p{font-size:12px;color:var(--muted);line-height:1.8}
  .tour-box .tour-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
  .tour-box button{font-size:11px;color:var(--bronze);background:transparent;border:1px solid var(--border-soft);border-radius:7px;padding:4px 14px;cursor:pointer}
 /* 附件 chips(升级:图片真缩略图/视频首帧 chip,数量多时换行+纵向滚动不溢出) */
  .att-bar{display:flex;gap:6px;flex-wrap:wrap;padding:4px 2px;max-height:132px;overflow-y:auto;overflow-x:hidden}
  .att-chip{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-chip);line-height:var(--lh-tight);color:var(--muted);border:1px solid var(--border-soft);border-radius:999px;padding:2px 10px}
  .att-chip img{width:16px;height:16px;border-radius:3px;object-fit:cover}
  .att-chip .ac-x{cursor:pointer;color:var(--faint)}
  .att-chip .ac-x:hover{color:var(--red)}
 /* 媒体 chip:缩略图 44px 方图(图片)/ 78×44 视频首帧;整块可点开 lightbox */
  .att-chip.att-media{padding:3px 9px 3px 3px;border-radius:10px}
  .att-chip.att-media .att-thumb{width:44px;height:44px;border-radius:7px;object-fit:cover;display:block;cursor:zoom-in;background:var(--sunken)}
  .att-chip.att-media .att-vthumb{width:78px;height:44px;border-radius:7px;object-fit:cover;display:block;cursor:zoom-in;background:var(--sunken)}
  .att-chip.att-text{cursor:pointer}
  .att-chip.att-text:hover{border-color:var(--bronze)}
  .att-chip .att-thumb:focus-visible,.att-chip .att-vthumb:focus-visible,.att-card .att-cthumb:focus-visible{outline:2px solid var(--focus-ring);outline-offset:1px}
  .att-kind{flex-shrink:0;font-family:var(--font-mono);font-size:var(--fs-chip);line-height:15px;color:var(--bronze);border:1px solid var(--border-soft);border-radius:4px;padding:0 5px;background:var(--chip-bg)}
  .att-meta{font-size:var(--fs-chip);color:var(--faint);font-family:var(--font-mono);white-space:nowrap}
  .att-card{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border-soft);border-radius:9px;background:var(--sunken);padding:6px 12px;margin:4px 6px 4px 0;font-size:11px;color:var(--muted)}
  .att-card img{width:40px;height:40px;border-radius:6px;object-fit:cover}
 /* 聊天流附件(回看链路):媒体卡可点开 lightbox;视频自带 controls 就地可播 */
  .att-row{display:flex;flex-wrap:wrap;align-items:flex-start;margin-top:2px}
  .att-card.att-media-card{padding:4px 10px 4px 4px;cursor:pointer}
  .att-card.att-media-card:hover{border-color:var(--bronze)}
  .att-card button.att-zoom{cursor:pointer;color:var(--bronze);background:transparent;border:1px solid var(--border-soft);border-radius:6px;padding:1px 8px;font-size:10px}
  .att-card img.att-cthumb{width:72px;height:72px;border-radius:7px;object-fit:cover;display:block;background:var(--sunken)}
  .att-card video.att-cvid{width:190px;max-width:42vw;height:auto;max-height:120px;border-radius:7px;display:block;background:#000}
 /* lightbox(F6):全屏遮罩 + 居中媒体 + 关闭;--overlay/--solid 走主题变量(暗/亮主题一致) */
  .att-lightbox{position:fixed;inset:0;z-index:150;background:var(--overlay);display:none;align-items:center;justify-content:center;padding:26px}
  .att-lightbox.on{display:flex}
  .att-lb-box{max-width:min(94vw,1240px);max-height:90vh;display:flex;flex-direction:column;gap:8px;background:var(--solid);border:1px solid var(--border);border-radius:14px;padding:12px 14px;box-shadow:0 24px 80px var(--overlay)}
  .att-lb-media{min-height:0;display:flex;align-items:center;justify-content:center}
  .att-lb-media img{max-width:min(88vw,1180px);max-height:74vh;object-fit:contain;border-radius:9px;display:block}
  .att-lb-media video{max-width:min(88vw,1180px);max-height:74vh;border-radius:9px;display:block;background:#000}
  .att-lb-media .att-lb-file{font-size:12px;color:var(--muted);padding:22px 10px;text-align:center;font-family:var(--mono)}
  .att-lb-text{max-width:min(1100px,92vw);max-height:78vh;overflow:auto;margin:0;padding:14px 16px;background:#100c09;border:1px solid var(--border);border-radius:8px;color:var(--text);font:12px/1.55 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
  .att-lb-bar{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--muted)}
  .att-lb-bar .att-lb-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:58vw}
  .att-lb-bar .att-lb-meta{color:var(--faint);font-family:var(--mono);font-size:10px}
  .att-lb-close{margin-left:auto;cursor:pointer;color:var(--muted);background:transparent;border:1px solid var(--border-soft);border-radius:7px;padding:3px 12px;font-size:11px}
  .att-lb-close:hover{color:var(--text);border-color:var(--border)}
  .composer-plus{position:relative;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--border-soft);border-radius:8px;color:var(--muted);cursor:pointer;font-size:15px;flex-shrink:0}
  .composer-plus:hover{border-color:var(--bronze);color:var(--text)}
 /* 远程向导 */
  .wiz-cmd{font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--code-bg);border:1px solid var(--border-soft);border-radius:9px;padding:10px 12px;margin-top:8px;white-space:pre-wrap;word-break:break-all;max-width:820px;position:relative}
  .wiz-copy{position:absolute;top:6px;right:8px;font-size:10px;color:var(--bronze);background:var(--bg);border:1px solid var(--border-soft);border-radius:6px;padding:2px 10px;cursor:pointer}
  .node-row .m-meta b{color:var(--green);font-weight:400}
  .node-row .m-meta b.off{color:var(--faint)}

 /* 设置页:两栏分区导航(参照 ZCode SettingsPage: 左 nav 分组+分区,右内容) */
  #view-sys{padding:14px 8px 14px 34px}
  .set-layout{display:flex;gap:20px;flex:1;min-height:0}
  .set-nav{width:168px;flex-shrink:0;display:flex;flex-direction:column;gap:2px;overflow-y:auto;padding:6px 6px 12px 0}
  .set-ngroup{font-size:9px;letter-spacing:2px;color:var(--faint);text-transform:uppercase;padding:12px 10px 4px}
  .set-nitem{font-size:12px;color:var(--muted);padding:6px 10px;border-radius:7px;cursor:pointer;user-select:none}
  .set-nitem:hover{background:var(--hover-bg);color:var(--text)}
  .set-nitem.on{background:rgba(201,143,69,.12);color:var(--accent-bright)}
  .set-content{flex:1;overflow-y:auto;min-width:0;padding-right:12px}
  .set-sec{display:none;flex-direction:column}
  .set-sec.on{display:flex}
  .prov-card{border:1px solid var(--border-soft);border-radius:10px;background:var(--glass2);padding:10px 14px;margin-bottom:8px;max-width:720px}
  .prov-head{display:flex;align-items:center;gap:10px}
  .prov-id{font-family:var(--mono);font-size:12px;color:var(--bronze)}
  .prov-name{font-size:12px;color:var(--text)}
  .prov-def{font-size:9px;color:var(--green);border:1px solid rgba(157,192,139,.4);border-radius:4px;padding:0 6px}
  .prov-url{font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:3px;word-break:break-all}
  .prov-acts{margin-left:auto;display:flex;gap:6px}
  .prov-act{font-size:10px;color:var(--muted);border:1px solid var(--border-soft);border-radius:6px;padding:2px 9px;cursor:pointer;background:transparent}
  .prov-act:hover{border-color:var(--bronze);color:var(--text)}
  .prov-test{font-size:10px;color:var(--faint);margin-top:3px}
 /* 生效模型区块:当前值/下拉/确认/状态四件套;与 composer pill 共用 staged/CAS 语义 */
  .ms-switch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:960px;margin:0 0 10px;padding:8px 10px;border:1px solid var(--border-soft);border-radius:9px;background:var(--glass2)}
  .ms-switch .ms-cur{display:flex;align-items:center;gap:6px;min-width:220px}
  .ms-switch .ms-cur .sk{font-size:10px;color:var(--faint)}
  .ms-switch .ms-cur b{font-size:12px;color:var(--text);font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ms-switch #msw-select{min-width:220px;max-width:380px}
  .ms-switch .ms-status{font-size:10px;color:var(--faint);flex:1 1 240px;line-height:1.4}
  .ms-switch .ms-status.err{color:var(--red)}
  .ms-switch .ms-status.ok{color:var(--green)}
  .ms-switch .ms-status.warn{color:var(--warn)}
  .ms-switch.readonly{opacity:.78;border-style:dashed}
  .ms-switch .ms-spin{display:inline-block;width:9px;height:9px;border:1.5px solid var(--faint);border-top-color:transparent;border-radius:50%;animation:ms-spin .8s linear infinite;vertical-align:-1px}
  @keyframes ms-spin{to{transform:rotate(360deg)}}
  #sec-model.cfg-readonly .preset-card{opacity:.6;cursor:not-allowed}
 /* Coding 模型结果态:默认只呈现 Provider/模型结果;添加过程收进弹窗(ZCode 配置面板范式) */
  #prov-modal-mask{position:fixed;inset:0;z-index:125;background:rgba(20,14,8,.34);backdrop-filter:blur(4px);
    display:flex;align-items:center;justify-content:center;padding:24px}
  #prov-modal-mask[hidden]{display:none}
  .prov-modal{width:min(860px,94vw);max-height:min(84vh,780px);display:flex;flex-direction:column;
    border:1px solid var(--border);border-radius:14px;background:var(--window-bg,rgba(10,7,5,.98));
    box-shadow:0 24px 80px rgba(0,0,0,.42);overflow:hidden}
  .prov-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
    padding:14px 16px 10px;border-bottom:1px solid var(--border-soft)}
  .prov-modal-head b{display:block;font-family:var(--serif);font-size:15px;letter-spacing:1.5px;color:var(--brand)}
  .prov-modal-head .sd{margin-top:3px;display:block}
  .prov-modal-close{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--muted);
    font-size:18px;line-height:1;cursor:pointer}
  .prov-modal-close:hover{background:var(--hover-bg2);color:var(--text)}
  .prov-modal-body{overflow:auto;padding:10px 16px 18px}
  .prov-sec-title{font-size:11px;letter-spacing:1px;color:var(--muted);margin:2px 0 7px}
  .prov-sec-title .sd{margin-left:4px}
  .prov-manual-sec{margin-top:12px;border-top:1px dashed var(--border-soft);padding-top:10px}
  .prov-manual-sec summary{cursor:pointer;font-size:11px;letter-spacing:1px;color:var(--muted);margin-bottom:7px}
  .prov-manual-sec summary:hover{color:var(--text)}
  .prov-add-row{display:flex;align-items:center;gap:8px;margin:2px 0 10px;flex-wrap:wrap}
  .cm-model-dir{margin:2px 0 10px;border:1px solid var(--border-soft);border-radius:9px;background:var(--glass2)}
  .cm-model-dir summary{cursor:pointer;padding:7px 10px;font-size:11px;color:var(--muted);display:flex;align-items:center;gap:8px}
  .cm-model-dir summary:hover{color:var(--text)}
  .cm-model-dir[open] summary{border-bottom:1px solid var(--border-soft)}
  .cm-model-dir .model-list{padding:8px 10px}
 /* ZCode 模型管理:模型列表行 */
  .prov-models{margin-top:8px;border-top:1px dashed var(--border-soft);padding-top:6px;max-height:300px;overflow-y:auto;padding-bottom:4px}
  .pv-mrow{display:flex;align-items:center;gap:6px;padding:2px 0}
  .pv-mname{flex:1;font-family:var(--mono);font-size:10.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pv-mbadge{font-size:var(--fs-chip);color:var(--bronze);border:1px solid var(--border-soft);border-radius:4px;padding:0 4px;margin-left:4px}
  .pv-mrow .num-in,.pv-madd .num-in{font-size:9.5px;padding:1px 6px}
 /* 单价覆盖行:模型行下方一行四个窄框(元/百万 token);留空=用内置价目表 */
  .pv-prow{display:flex;align-items:center;gap:4px;margin-left:6px;padding-left:6px;border-left:1px dashed var(--border-soft)}
  .pv-pl{font-size:9px;color:var(--faint);letter-spacing:1px;white-space:nowrap}
  .pv-prow .num-in{font-size:9.5px;padding:1px 5px}
  .pv-mrow{flex-wrap:wrap}
  .pv-madd{display:flex;gap:6px;margin-top:4px}
  .prov-test.ok{color:var(--green)}
  .prov-test.bad{color:var(--red)}
 /* Coding 模型设置:角色下拉/能力徽标/自定义模型/高级折叠(全部走 088 主题变量) */
  .cm-roles{display:grid;grid-template-columns:repeat(2,minmax(250px,1fr));gap:8px 12px;max-width:900px}
  .cm-role{border:1px solid var(--border-soft);border-radius:10px;background:var(--glass2);padding:9px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}
  .cr-head{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
  .cr-name{font-size:12px;color:var(--text);font-weight:500}
  .cr-sub{font-family:var(--mono);font-size:9px;color:var(--faint)}
  .cm-select{width:100%;background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);
    font-size:11.5px;padding:5px 8px;outline:none;font-family:var(--mono);min-width:0}
  .cm-select:focus{border-color:var(--bronze)}
  .cm-select-inline{width:auto;max-width:170px;font-family:var(--sans);font-size:10.5px;padding:3px 6px}
  .cr-foot{display:flex;align-items:center;gap:8px;justify-content:space-between}
  .cr-hint{font-size:10px;color:var(--faint);line-height:1.5}
  .cm-effort-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 0 6px;max-width:900px;border-bottom:1px solid var(--border-soft)}
  .cm-effort-row .sk{font-size:13px;color:var(--text);width:170px;flex-shrink:0;font-weight:500}
  .cm-adv{margin-top:16px;max-width:900px}
  .cm-adv>summary{cursor:pointer;font-size:11px;color:var(--bronze);letter-spacing:1px;padding:8px 0;list-style:none;user-select:none}
  .cm-adv>summary::-webkit-details-marker{display:none}
  .cm-adv>summary::before{content:"›";display:inline-block;margin-right:7px;transition:transform .15s;color:var(--faint)}
  .cm-adv[open]>summary::before{transform:rotate(90deg)}
  .cm-adv .set-row{padding:10px 0}
  .cm-addmodel{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;max-width:900px}
  .cm-adname{width:190px}
  #sec-model .set-group{flex-wrap:wrap}
  #sec-model .set-group .gt{white-space:nowrap}
  #sec-model .cm-addprov{flex-wrap:wrap;max-width:900px}
  .cm-mrow{display:flex;align-items:center;gap:7px;border:1px solid var(--border-soft);border-radius:8px;background:var(--glass2);
    padding:5px 10px;margin-bottom:5px;font-size:11px}
  .cm-mrow .cm-mname{flex:1;min-width:120px;font-family:var(--mono);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cm-mrow .cm-mprov{font-size:9px;color:var(--faint);white-space:nowrap}
  .cm-mrow .mr-tag{font-size:9px;color:var(--green);border:1px solid rgba(157,192,139,.4);border-radius:4px;padding:0 5px;white-space:nowrap}
  .cm-mrow .mr-tag.r{color:var(--warn);border-color:rgba(217,179,108,.4)}
  .cm-mrow .mr-tag.mr-probe{color:var(--faint);border-color:var(--border-soft)}
  .cm-mrow .mr-tag.mr-ok{color:var(--green)}
  .cm-mrow .mr-tag.mr-bad{color:var(--red);border-color:rgba(224,138,122,.4)}
  .cm-mrow .num-in{width:84px;font-size:9.5px;padding:2px 5px}
  .cm-mrow button{font-size:10px;color:var(--muted);border:1px solid var(--border-soft);border-radius:6px;padding:2px 8px;cursor:pointer;background:transparent;white-space:nowrap}
  .cm-mrow button:hover{border-color:var(--bronze);color:var(--text)}
  .cm-mrow.off{opacity:.55}
  .cap-chip{font-size:var(--fs-chip)!important;border-radius:5px!important;padding:1px 6px!important}
  .cap-chip.on{color:var(--green)!important;border-color:rgba(157,192,139,.45)!important}
  .cap-chip.off{color:var(--faint)!important;text-decoration:line-through}
 /* 未知=不显示:Provider 模型行悬停时才露出未标注能力的标记入口 */
  .pv-mrow .cap-chip.unknown{display:none}
  .pv-mrow:hover .cap-chip.unknown{display:inline-block;color:var(--faint)!important;opacity:.8}
  .prov-proto{font-size:9px;color:var(--bronze);border:1px solid var(--border-soft);border-radius:4px;padding:0 6px}
  .prov-proto.warn{color:var(--warn);border-color:rgba(217,179,108,.4)}
  .prov-edit{display:grid;grid-template-columns:repeat(2,minmax(200px,1fr));gap:8px 12px;margin-top:8px;padding:9px 0;border-top:1px dashed var(--border-soft)}
  .prov-edit label{display:flex;flex-direction:column;gap:3px;font-size:10px;color:var(--faint)}
  .prov-edit input,.prov-edit select,.prov-edit textarea{width:100%;background:var(--input-bg);border:1px solid var(--input-border);
    border-radius:7px;color:var(--text);font-size:10.5px;padding:4px 7px;outline:none;font-family:var(--mono);box-sizing:border-box}
  .prov-edit textarea{resize:vertical;min-height:38px}
  .prov-edit .pe-wide{grid-column:1/-1}
  .prov-edit-foot{grid-column:1/-1;display:flex;gap:8px;align-items:center}
  @media(max-width:1100px){.cm-roles{grid-template-columns:1fr}.cm-effort-row .sk{width:auto}.prov-edit{grid-template-columns:1fr}}
  .tool-item{border:1px solid var(--border-soft);border-radius:10px;background:var(--glass2);padding:10px 14px;margin-bottom:8px;max-width:640px}
  .tool-name{font-family:var(--mono);font-size:12px;color:var(--bronze)}
  .tool-desc{font-size:11px;color:var(--muted);margin-top:3px}
 /* 旧设置分组样式(set-group/set-row 兼容保留) */
  .set-group{margin:20px 0 8px;display:flex;align-items:center;gap:10px}
  .set-group .gt{font-size:12px;letter-spacing:1.5px;color:var(--bronze);text-transform:uppercase;font-weight:600}
  .set-group .gl{flex:1;height:1px;background:var(--border-soft)}
  .set-group .sd{font-size:11px;color:var(--faint)}
  .set-row{display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--border-soft);max-width:860px}
  .set-row .sk{font-size:13.5px;color:var(--text);width:170px;flex-shrink:0;font-weight:500}
  .set-row .sd{font-size:11px;color:var(--faint);margin-top:2px;line-height:1.6}
  .seg{display:flex;border:1px solid var(--border-soft);border-radius:8px;overflow:hidden;flex-shrink:0}
  .seg button{padding:4px 13px;font-size:11px;background:transparent;border:none;color:var(--muted);letter-spacing:1px}
  .seg button + button{border-left:1px solid var(--border-soft)}
  .seg button.on{background:linear-gradient(135deg,var(--grad-a),var(--grad-b));color:var(--on-accent)}
  .num-in{width:70px;background:var(--glass);border:1px solid var(--border-soft);border-radius:8px;
          color:var(--text);padding:5px 8px;font-size:11px;font-family:var(--mono);outline:none;text-align:center}
  .num-in:focus{border-color:var(--bronze)}
  .cfg-ok{color:var(--green)}
  .cfg-wait{color:var(--warn)}

 /* 命令中心(Ctrl+K,复刻 ZCode CommandCenterDialog 简版) */
  #cc{position:fixed;inset:0;z-index:20;display:none;background:var(--overlay);backdrop-filter:blur(2px)}
  #cc.on{display:flex;align-items:flex-start;justify-content:center;padding-top:14vh}
  .cc-box{width:min(560px,80vw);background:#120c07;border:1px solid var(--border);border-radius:14px;
          box-shadow:0 18px 60px rgba(0,0,0,.6);overflow:hidden}
  .cc-box input{width:100%;border:none;border-bottom:1px solid var(--border-soft);background:transparent;
                color:var(--text);padding:14px 16px;font-size:13px;outline:none}
  .cc-box input::placeholder{color:var(--faint)}
  #cc-list{max-height:44vh;overflow-y:auto;padding:6px}
  .cc-item{display:flex;align-items:center;gap:9px;padding:8px 12px;border-radius:8px;cursor:pointer}
  .cc-item:hover,.cc-item.hot{background:rgba(201,143,69,.10)}
  .cc-item .ct{flex:1;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cc-item:hover .ct{color:var(--text)}
 /* 会话搜索域:标题+来源徽标/时间一行,命中片段两行(«»→mark 高亮) */
  .cc-item.cc-sess{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"t meta" "s s";
                   gap:2px 10px;align-items:start;padding:7px 12px}
  .cc-sess .ct{grid-area:t;min-width:0}
  .cc-sess .cc-meta{grid-area:meta;font-family:var(--mono);font-size:9px;color:var(--faint);white-space:nowrap}
  .cc-sess .cc-snip{grid-area:s;font-size:10.5px;line-height:1.55;color:var(--faint);
                    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .cc-sess mark{background:rgba(201,143,69,.28);color:var(--accent-bright);border-radius:2px;padding:0 1px}
  .cc-sess .cc-badge{font-size:var(--fs-chip);color:var(--warn);border:1px solid rgba(217,179,108,.4);
                     border-radius:4px;padding:0 4px;margin-left:5px;vertical-align:1px}
  .cc-empty{padding:18px;text-align:center;font-size:11px;color:var(--faint)}
 /* 全局次级信息类:子代理/追踪/用量三卡等大量使用 class="dim" 标注次级文字,
 此前全仓只在 .term-line/.sense-detail/.g .node 等局部作用域定义过 → 这些位置次级信息与正文同亮度。 */
  .dim{color:var(--muted)}
  body.light .dim{color:var(--muted)}
 /* ---- 看板三件套(子代理/任务追踪/用量)统一骨架 ----
 痛点:三卡此前各自内联 style,列宽靠 min-width 猜 → 一屏内对不齐、数字跳列、次级信息无层级。 */
  .bd3-sec{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.6px;margin:0 0 6px}
  .bd3-sec .bd3-n{font-family:var(--mono);font-size:9.5px;font-weight:400;color:var(--faint)}
  .bd3-row{border:1px solid var(--border);border-radius:8px;padding:5px 10px;background:rgba(255,255,255,.02)}
  .bd3-row+.bd3-row{margin-top:6px}
  .bd3-row.click{cursor:pointer}
  .bd3-row.click:hover{border-color:var(--bronze);background:var(--hover-bg)}
  .bd3-row.bd3-bad{border-left:2px solid var(--red)}
  .bd3-line{display:flex;gap:9px;align-items:center;font-size:11.5px;min-width:0}
  .bd3-line>.bd3-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bd3-dot{width:8px;height:8px;border-radius:50%;background:var(--faint);flex-shrink:0}
  .bd3-dot.run{background:var(--green);box-shadow:0 0 8px rgba(157,192,139,.55)}
  .bd3-dot.ok{background:var(--green)}
  .bd3-dot.fail{background:var(--red)}
  .bd3-st{font-size:10px;color:var(--muted);flex-shrink:0}
  .bd3-warn{font-size:10px;color:var(--warn);flex-shrink:0}
  .bd3-snip{margin-top:3px;font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bd3-chips{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px}
  .bd3-chip{font-size:var(--fs-chip);padding:2px 9px;border-radius:20px;border:1px solid var(--border-soft);background:transparent;color:var(--muted);cursor:pointer}
  .bd3-chip:hover{border-color:var(--bronze);color:var(--text)}
  .bd3-chip.on{border-color:var(--bronze);color:var(--accent-bright);background:var(--accent-soft)}
  .bd3-tasks{display:flex;flex-direction:column;gap:8px}
  .bd3-trail{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
  .bd3-ph{font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid var(--border)}
  .bd3-ph.cur{border-color:var(--bronze);color:var(--bronze)}
  .bd3-ph.dim2{opacity:.4}
  .bd3-todos{margin-top:4px;display:flex;flex-direction:column;gap:1px}
  .bd3-todo{font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 /* ---- 追踪 Trace:单数据窗口----
 * 统计区(#sw-slot 内 status-widget)与 turn 树(#track-body)同属一个流式滚动区;
 * 统计区无数据时整块不占位(sw-active 由 widget 自己切),turn 树因此恒为最后一个数据块。 */
  #sw-slot{display:none;flex:0 0 auto;padding:0 2px 8px;margin-bottom:8px;border-bottom:1px solid var(--border-soft)}
  #sw-slot.sw-active{display:block}
  #track-body{flex:0 0 auto;display:flex;flex-direction:column;gap:8px}
 /* 数据块小标题(统计区/任务区共用视觉语言;不依赖 status-widget 注入的样式) */
  .tk-hd{display:flex;align-items:center;gap:8px;margin:2px 0 6px}
  .tk-hd-t{font-family:var(--mono);font-size:9px;letter-spacing:2.6px;color:var(--faint)}
  .tk-hd:after{content:'';flex:1;height:1px;background:linear-gradient(90deg,rgba(201,162,94,.26),rgba(201,162,94,0))}
 /* ---- 追踪 Trace:turn 三级树(重设计)----
 * 一级 turn 卡 · 二级五阶段(左侧引导线) · 三级阶段任务(note 圆点列表) */
  .tk-turn{border:1px solid var(--border-soft);border-radius:12px;margin:8px 0;overflow:hidden;
           background:linear-gradient(180deg,rgba(201,162,94,.055),rgba(201,162,94,.012))}
  .tk-turn>summary{display:flex;align-items:center;gap:8px;padding:8px 11px;cursor:pointer;font-size:12px;user-select:none;
                   list-style:none;flex-wrap:nowrap}
  .tk-turn>summary::-webkit-details-marker{display:none}
  .tk-turn>summary:hover{background:var(--hover-bg)}
  .tk-turn[open]>summary{border-bottom:1px dashed rgba(201,162,94,.20)}
  .tk-n{font-family:var(--mono);font-size:9px;letter-spacing:.4px;color:var(--bronze);background:rgba(201,162,94,.10);
        border:1px solid rgba(201,162,94,.28);border-radius:6px;padding:1px 7px;flex-shrink:0}
  .tk-user{color:var(--text);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tk-meta{font-family:var(--mono);font-size:9px;color:var(--faint);flex-shrink:0;white-space:nowrap}
  .tk-body{padding:8px 12px 10px 14px;position:relative}
  .tk-body:before{content:"";position:absolute;left:20px;top:4px;bottom:12px;width:1px;
                  background:linear-gradient(180deg,rgba(201,162,94,.28),rgba(201,162,94,.05))}
  .tk-ph{margin:2px 0;padding-left:14px;border-left:1px solid transparent}
  .tk-ph>summary{display:flex;align-items:center;gap:7px;cursor:pointer;font-size:11px;color:var(--muted);
                 padding:3px 0;list-style:none}
  .tk-ph>summary::-webkit-details-marker{display:none}
  .tk-ph[open]>summary{color:var(--text)}
  .tk-ph-i{font-family:var(--mono);font-size:8.5px;color:var(--faint);opacity:.75;flex-shrink:0}
  .tk-ph-hint{font-family:var(--mono);font-size:8.5px;color:var(--faint);margin-left:auto;flex-shrink:0}
  .tk-notes{display:flex;flex-direction:column;gap:1px;margin:1px 0 5px 6px;padding-left:12px;
            border-left:1px solid rgba(201,162,94,.16)}
  .tk-note{position:relative;font-size:11px;line-height:1.5;color:var(--muted);padding:3px 0 3px 11px;
           white-space:pre-wrap;overflow-wrap:anywhere}
  .tk-note:before{content:"";position:absolute;left:0;top:10px;width:4px;height:4px;border-radius:50%;
                  background:var(--bronze);opacity:.65}
  .tk-note-skip{color:var(--faint);font-style:italic}
  .tk-note-skip:before{background:var(--faint);opacity:.4}
  .tk-note-auto:before{background:var(--ok,#7fb069)}
  .tk-auto-tag{margin-left:6px;font-size:9px;color:var(--ok,#7fb069);border:1px solid var(--ok,#7fb069);border-radius:3px;padding:0 3px;opacity:.85}
  .bd3-grid{display:grid;grid-template-columns:minmax(88px,1.5fr) minmax(66px,1fr) 46px 64px 64px 64px;gap:8px;align-items:center;
            font-size:11px;white-space:nowrap}
  .bd3-grid.nc{grid-template-columns:minmax(88px,1.5fr) minmax(66px,1fr) 46px 64px 64px}
  .bd3-grid>.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
  .bd3-grid>.ell{overflow:hidden;text-overflow:ellipsis}
  .bd3-hd{color:var(--muted);font-size:9.5px;letter-spacing:.5px;padding:0 2px 5px;border-bottom:1px solid var(--border-soft)}
  .bd3-grid.bd3-line-row{padding:4px 2px;border-bottom:1px solid var(--border-soft)}
  .bd3-tot{color:var(--text);font-weight:600;padding-top:6px}
  .bd3-note{font-size:10px;color:var(--faint);margin:6px 0 0}
  .cc-foot{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--border-soft);font-size:9px;color:var(--faint)}

 /* 洞察视图 */
  .sense-bar{display:flex;gap:10px;margin-bottom:10px}
  .sense-bar input{flex:1;background:var(--glass);border:1px solid var(--border-soft);border-radius:10px;
                   color:var(--text);padding:9px 12px;font-size:12px;outline:none}
  .sense-bar input:focus{border-color:var(--bronze)}
  .sense-bar select{background:var(--glass);border:1px solid var(--border-soft);border-radius:10px;
                    color:var(--text);padding:8px 10px;font-size:11px;outline:none}
  .sense-bar .go{padding:0 18px;border-radius:10px;border:1px solid var(--border-soft);background:transparent;color:var(--text);font-size:12px;letter-spacing:2px}
  .sense-bar .go:hover{background:linear-gradient(135deg,var(--grad-a),var(--grad-b));color:#1c1108}
  .sense-meta{font-family:var(--mono);font-size:10px;color:var(--muted);margin-bottom:8px}
  .sense-meta b{color:var(--bronze)}
  .sense-main{flex:0 0 auto;min-height:48px;max-height:30vh;overflow-y:auto;
              font-family:var(--serif);font-size:16px;line-height:1.9;color:var(--reply);
              border-left:2px solid var(--bronze-dim);padding-left:12px;margin-bottom:10px;white-space:pre-wrap}
  .sense-detail{flex:1;overflow-y:auto;font-family:var(--mono);font-size:11px;line-height:1.75;
                color:var(--muted);white-space:pre-wrap;word-break:break-word}
  .sense-detail .sec{color:var(--bronze)}
  .sense-detail .dim{color:var(--faint)}

 /* 代码档案 tab(产品决策:wiki 并入代码档案,不再有独立一级视图) */
  #view-project{overflow:hidden}
  .pp-tabs{display:flex;gap:4px;margin:2px 0 10px;border-bottom:1px solid var(--border-soft);padding-bottom:6px}
  .pp-tab{background:transparent;border:1px solid transparent;border-radius:8px;color:var(--muted);font-size:11.5px;
          padding:4px 14px;cursor:pointer;letter-spacing:.5px}
  .pp-tab:hover{color:var(--text);background:var(--hover-bg)}
  .pp-tab.on{color:var(--bronze);background:var(--accent-soft);border-color:var(--border-soft)}
  .pp-tabpane{display:none;flex:1;min-height:0;flex-direction:column}
  .pp-tabpane.on{display:flex}
  #ppTab-files{overflow-y:auto}
  #ppTab-files .ppf{margin-top:0;border-top:0;padding-top:0;flex:1}
 /* 总路线 tab(原侧栏「总线路」一级视图并入代码档案;上=宗旨主线,下=任务漏斗) */
  #ppTab-roadmap{overflow-y:auto}
  .rm-wrap{display:flex;flex-direction:column;gap:14px;padding-bottom:18px}
  .rm-purpose{border:1px solid var(--border-soft);border-radius:12px;background:var(--glass);padding:12px 14px}
  .rm-purpose-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
  .rm-meta{font-family:var(--mono);font-size:9.5px;color:var(--faint);flex:1;min-width:160px;
           overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rm-purpose-line{font-family:var(--serif);font-size:14.5px;line-height:1.7;color:var(--reply);
                    border-left:2px solid var(--bronze-dim);padding-left:10px;margin-bottom:10px;white-space:pre-wrap}
  .rm-sec-t{font-size:9.5px;letter-spacing:1.6px;color:var(--faint);text-transform:uppercase;margin:8px 0 4px}
  .rm-item{font-size:11.5px;line-height:1.7;color:var(--muted);display:flex;gap:6px;align-items:baseline}
  .rm-item .rm-k{color:var(--bronze);font-family:var(--mono);font-size:9.5px;flex:none}
  .rm-item.rm-drift .rm-k{color:var(--warn)}
  .rm-facts{font-family:var(--mono);font-size:9.5px;color:var(--faint);line-height:1.8;margin-top:8px;
            white-space:pre-wrap;word-break:break-word}
  .rm-funnel{border:1px solid var(--border-soft);border-radius:12px;background:var(--glass);padding:12px 14px}
  .rm-funnel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
  .wiki-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;padding:0 2px}
  .wiki-bar-meta{font-family:var(--mono);font-size:9.5px;color:var(--faint);flex:1;min-width:180px;
                 overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #view-project[data-tab="wiki"] .pp-head .vw-act,
  #view-project[data-tab="wiki"] .pp-head .pp-state,
  #view-project[data-tab="wiki"] .pp-head .pp-bar,
  #view-project[data-tab="wiki"] .pp-head .pp-pct{display:none}
  body.pp-wiki-tab #sc-root{display:none}
  body.pp-wiki-tab .page{padding-right:12px}

 /* 仓库 Wiki(代码档案 · Wiki tab):左页导航 + 右 markdown(引用可点回源)+ 页内 mermaid */
  .wiki-body{display:grid;grid-template-columns:238px minmax(0,1fr);gap:12px;flex:1;min-height:0}
  .wiki-nav{border:1px solid var(--border-soft);border-radius:12px;background:var(--glass);
            padding:8px;overflow:auto;min-height:0}
  .wiki-group{margin-bottom:10px}
  .wiki-group-t{font-size:9.5px;letter-spacing:1.6px;color:var(--faint);padding:4px 8px 3px;text-transform:uppercase}
  .wiki-page{display:flex;gap:8px;align-items:center;padding:6px 8px;border-radius:8px;cursor:pointer;
             font-size:12px;color:var(--muted);border:1px solid transparent}
  .wiki-page:hover{background:var(--hover-bg);color:var(--text)}
  .wiki-page.on{background:var(--accent-soft);color:var(--bronze);border-color:var(--border-soft)}
  .wiki-page-t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wiki-refs{font-family:var(--mono);font-size:9px;color:var(--faint)}
  .wiki-content{display:flex;flex-direction:column;min-width:0;min-height:0}
  .wiki-page-head{display:flex;align-items:baseline;gap:10px;padding:0 2px 8px;min-height:20px}
  .wiki-page-title{font-family:var(--serif);font-size:15px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wiki-page-cites{font-family:var(--mono);font-size:9.5px;color:var(--faint);margin-left:auto;white-space:nowrap}
  .wiki-md{flex:1;overflow:auto;border:1px solid var(--border-soft);border-radius:12px;background:var(--glass);
           padding:16px 24px 28px;font-size:13px;line-height:1.78;color:var(--reply);min-height:0}
  .wiki-md h3{font-family:var(--serif);font-size:22px;font-weight:600;color:var(--text);margin:2px 0 12px;letter-spacing:.5px}
  .wiki-md h4{font-family:var(--serif);font-size:15.5px;color:var(--bronze);margin:18px 0 8px;letter-spacing:.4px}
  .wiki-md h5{font-size:12.5px;color:var(--text);margin:14px 0 6px;letter-spacing:.3px}
  .wiki-md p{margin:7px 0}
  .wiki-md ul,.wiki-md ol{margin:6px 0 8px;padding-left:20px}
  .wiki-md li{margin:3px 0}
  .wiki-md blockquote{margin:10px 0;padding:8px 14px;border-left:2px solid var(--bronze-dim);
                      background:var(--sunken);color:var(--muted);font-size:12.5px}
  .wiki-md table{border-collapse:collapse;margin:10px 0;font-size:11.5px;width:100%}
  .wiki-md th,.wiki-md td{border:1px solid var(--border-soft);padding:4px 9px;text-align:left;vertical-align:top}
  .wiki-md th{background:var(--sunken);color:var(--bronze);font-weight:500}
  .wiki-md code{font-family:var(--mono);font-size:.92em;background:var(--code-bg);border-radius:4px;padding:1px 5px;color:var(--accent-bright)}
  .wiki-md pre{overflow:auto;background:var(--code-bg);border:1px solid var(--border-soft);border-radius:9px;
               padding:10px 13px;margin:9px 0;font-size:11px;line-height:1.6}
  .wiki-md pre code{background:none;padding:0;color:var(--text)}
  .wiki-md .md-mermaid{overflow:auto;margin:10px 0;padding:8px;border:1px solid var(--border-soft);border-radius:10px;background:var(--sunken)}
  .wiki-md .md-mermaid svg{max-width:100%;height:auto}
  .md-mermaid{overflow:auto;max-width:100%;margin:10px 0;padding:8px;border:1px solid var(--border-soft);border-radius:10px;background:var(--sunken)} /* mermaid 懒加载占位容器(消息流;wiki-md 内已有特化) */
  .md-mermaid svg{max-width:100%;height:auto}
  .md-mermaid pre.md-mermaid-src{margin:0;color:var(--text)}
 /* 富图形交付:md 围栏 html / svg 渲染成「可看图卡」(mermaid 表达不了的设计稿级
 分层容器/散点带/编号标注)。html 走 sandbox="" iframe(内联源再带 CSP default-src 'none'),
 svg 由 artSanitizeSvg 解析剥险后内联;失败/超 512KB 回落代码块 + 一行说明(.md-art-note)。 */
  .md-artifact{position:relative;margin:var(--gap-block) 0;border:1px solid var(--border-soft);border-radius:10px;
    background:var(--sunken);overflow:hidden;max-width:100%}
  .md-artifact-bar{display:flex;align-items:center;gap:8px;padding:3px 10px;border-bottom:1px solid var(--border-soft);
    background:var(--hover-bg);font-family:var(--font-mono);font-size:var(--fs-tool);line-height:var(--lh-code);color:var(--faint)}
  .md-artifact-bar .art-kind{display:inline-flex;align-items:center;gap:5px;letter-spacing:.4px}
  .md-artifact-bar .art-kind::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--bronze);opacity:.7;flex-shrink:0}
  .md-artifact-bar .art-sp{flex:1}
  .md-artifact-bar button{border:none;background:transparent;color:var(--faint);cursor:pointer;
    font-family:var(--font-mono);font-size:var(--fs-tool);padding:1px 6px;border-radius:5px}
  .md-artifact-bar button:hover{color:var(--bronze);background:var(--hover-bg2)}
  .md-artifact .art-body{display:block;overflow:auto}
  .md-artifact.md-html .art-body iframe{display:block;width:100%;border:0;background:#0b0806}
  .md-artifact.md-svg .art-body{padding:8px}
  .md-artifact.md-svg .art-body svg{display:block;max-width:100%;height:auto}
  .md-artifact.md-svg.art-raw .art-body svg{max-width:none}
  .md-artifact.art-fs{position:fixed;left:12px;right:12px;top:12px;bottom:12px;z-index:9000;margin:0;
    display:flex;flex-direction:column;background:var(--window-bg);box-shadow:0 24px 80px rgba(0,0,0,.72)}
  .md-artifact.art-fs .art-body{flex:1;min-height:0}
  .md-artifact.art-fs.md-html .art-body iframe{height:100%!important}
  .md-artifact.art-fs.md-svg .art-body{display:flex;align-items:center;justify-content:center}
  .md-artifact.art-fs.md-svg .art-body svg{max-width:100%;max-height:100%}
  .md-artifact .art-body pre.code{margin:0;border:none;border-radius:0;background:transparent;padding:8px 10px;
    font-family:var(--font-mono);font-size:var(--fs-code);line-height:var(--lh-code)}
  .md-art-note{color:var(--faint);font-size:var(--fs-tool);line-height:1.7;margin:2px 0 4px}
  .wiki-md a.cite{border-bottom-style:dotted}
  .wiki-md hr{border:0;border-top:1px solid var(--border-soft);margin:14px 0}
  .wiki-empty-note{color:var(--muted);font-size:12px;line-height:1.8}
  .wiki-page-head .vw-act{font-size:10px;padding:2px 9px}
  @media (max-width:1100px){.wiki-body{grid-template-columns:190px minmax(0,1fr)}}
  @media (max-width:900px){
    .wiki-body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
    .wiki-nav{max-height:168px}
  }

 /* footer(companion):AFFINITY 金线 + 快捷卡 + composer —— 仅 chat 视图显示(composer 属于对话,复刻 ZCode) */
  footer{padding:0 28px 16px 34px;flex-shrink:0} /* 全流宽(自由伸缩:composer 跟随聊天窗宽度,原 680 写死) */
  body:not([data-view="chat"]) footer{display:none}
 /* 经典聊天态:右下 Super Agent 悬浮窗上移到输入区上方——否则 1600×900 下
 它(x1224-1584,y616-846)整块压住模型 pill / 力度 / 发送按钮(实测 elementFromPoint 命中 sc-*)。
 同时只留头部条(同 dual-center 口径),待处理明细走头部的「⤢ 展开指挥台」overlay。 */
  body[data-view="chat"]:not(.cv-shell) #superConsole{bottom:calc(var(--bnav-h,44px) + 240px)}
  body[data-view="chat"]:not(.cv-shell) #sc-root .sc-body,
  body[data-view="chat"]:not(.cv-shell) #sc-root .sc-foot{display:none}
  .aff-head{display:flex;align-items:baseline;margin-bottom:6px}
  .aff-title{font-size:9px;letter-spacing:3px;color:var(--faint);text-transform:uppercase}
  .aff-stage{margin-left:auto;font-family:var(--serif);font-size:13px;color:var(--bronze);letter-spacing:2px}
  .aff-bar{height:3px;border-radius:2px;background:var(--accent-soft);overflow:hidden;margin-bottom:8px}
  .aff-bar i{display:block;height:100%;width:0;border-radius:2px;background:linear-gradient(90deg,var(--grad-b),var(--grad-a));transition:width .5s}
  .aff-stats{font-size:10px;color:var(--faint);letter-spacing:1px}
 /* footer 双段条:左=管线状态,右=轮次时间轴(#turnNav 迁入,同高不增 footer 高度) */
  .aff-strip{display:flex;align-items:flex-end;gap:16px;margin-bottom:9px;min-width:0}
  .aff-strip .aff-stats{flex-shrink:0;white-space:nowrap;margin-bottom:1px}
  .input-row{display:flex;align-items:flex-end;gap:10px;margin-top:3px}
  .input-row input{flex:1;border:0;border-bottom:1px solid var(--border-soft);background:transparent;
                   color:var(--text);font-size:14px;padding:6px 2px;outline:none;font-family:var(--sans);min-height:24px}
  .input-row input:focus{border-color:var(--bronze)}
  .input-row input::placeholder{color:var(--faint)}
  .send-btn{width:32px;height:32px;border-radius:50%;border:1px solid var(--bronze);flex-shrink:0;
            background:var(--accent-soft);color:var(--text);font-size:13px;transition:.2s} /* 亮色对比度:glass2 底+bronze 字仅 ~2.7:1 → accent-soft 底+语义文本色(与表头同修),铜边保身份 */
  .send-btn:hover{border-color:var(--bronze);box-shadow:0 0 16px var(--bronze-glow)}
 /* 斜杠指令面板(ZCode SlashCommandPlugin 移植) */
  footer{position:relative}
 /* 批A:多行输入/ markdown/工具卡/状态条/查找/错误横幅 */
  .input-row textarea{flex:1;border:0;border-bottom:1px solid var(--border-soft);background:transparent;
                   color:var(--text);font-size:14px;padding:6px 2px;outline:none;font-family:var(--sans);min-height:24px;
                   max-height:160px;resize:none;line-height:1.5}
  .input-row textarea:focus{border-color:var(--bronze)}
 /* composer 容器(视频 2:模型/模式/思考/用量入框,ZCode composer 对齐) */
  .composer{border:1px solid var(--border-soft);border-radius:12px;background:var(--input-bg);padding:4px 10px 6px;margin-top:3px;position:relative}
  .composer:focus-within{border-color:var(--bronze)}
  .composer textarea{width:100%;border:0;border-bottom:1px solid var(--border-soft);background:transparent;
                   color:var(--text);font-size:14px;padding:6px 2px;outline:none;font-family:var(--sans);min-height:24px;
                   max-height:160px;resize:none;line-height:1.5;box-sizing:border-box}
  .composer textarea:focus{border-color:transparent}
 /* 输入框指令 chip 覆盖层——chip 态渲染不可编辑的指令占位符,textarea 首行文字自 padding-left 起;
 全变量取色(--chip-bg/--bronze/--accent-bright)=七主题自动成立;pointer-events:none 让点击穿透聚焦 textarea。 */
  #inChip{position:absolute;left:12px;top:10px;z-index:5;display:none;align-items:center;max-width:72%;pointer-events:none}
  #inChip .slash-chip{background:var(--chip-bg);border:1px solid var(--border-soft);border-radius:6px;padding:2px 8px;box-shadow:0 1px 4px rgba(0,0,0,.22)}
  #inChip .slash-chip .sc-args{font-size:var(--fs-chip);color:var(--faint);letter-spacing:1px}
  .composer-bar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding-top:4px}
 /* busy 视觉态:有在办任务时 composer 边框暖色提示「输入会排队」(ref:busy 不禁用输入,
 转排队语义;textarea 本身永不禁用)。占位符双态见 renderSendBtn。 */
  .composer.busy{border-color:rgba(217,179,108,.55)}
  .send-btn.stop{border-color:var(--red);color:var(--red)}
 /* 语音任务书:录音态按钮红脉冲;撰写锁态 composer 降透明+textarea 只读灰字。
 禁输入用 readOnly(保留文本可选中/复制),不用 disabled(避免丢焦点与提交路径分叉)。 */
  .composer-plus.rec{border-color:var(--red);color:var(--red);animation:vrecPulse 1.2s ease-in-out infinite}
  @keyframes vrecPulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--red) 40%,transparent)}50%{box-shadow:0 0 0 6px transparent}}
  .composer.voice-wait{opacity:.82}
  .composer.voice-wait textarea{color:var(--faint)}
 /* 正文内联代码/围栏块统一走板令牌(原硬编码 rgba 在浅色主题出暗块)
 围栏块与 .code-wrap 同族同规格(font-mono + fs-code + lh-code);行内 code 用 fs-code-sm
 (相对正文比例,不随正文字号漂移)。 */
  .task-reply pre{background:var(--surf-code);border:1px solid var(--border-soft);border-radius:8px;
    padding:var(--gap-block) 10px;font-family:var(--font-mono);font-size:var(--fs-code);line-height:var(--lh-code);
    overflow-x:auto;margin:var(--gap-block) 0;white-space:pre-wrap;word-break:break-word;letter-spacing:var(--ls-code)}
  .task-reply code{font-family:var(--font-mono);font-size:var(--fs-code-sm);color:var(--accent-bright);
    background:color-mix(in srgb,var(--bronze) 14%,transparent);border:1px solid color-mix(in srgb,var(--bronze) 22%,transparent);border-radius:4px;padding:1px 5px;letter-spacing:var(--ls-code)}
  .task-reply pre code{background:transparent;padding:0;font-size:var(--fs-code)}
  .task-reply a{color:var(--bronze)}
 /* 正文内强调/标题/引用分层——正文是唯一「重点层」,其中的小结构也要能一眼分级:
 h 级标题带左侧粗条,b/i 加强,b/mark 高亮,引用块走板,none 处保持 serif 大字。
 分型排版规范:标题一律 --font-ui + 三档字号(h1=正文×1.3 / h2=×1.15 / h3=×1.0,
 上限即正文×1.3,不允许更大);正文段落 / 标题 / 表格 / 引用统一 --gap-block 块距;
 列表缩进走 --indent-1 / --indent-2(嵌套);引用左 3px 边条 + --indent-1 左缩进。 */
  .task-reply b,.task-reply strong{color:var(--accent-bright);font-weight:600}
  .task-reply em,.task-reply i{color:var(--brand);font-style:italic}
  .task-reply del{color:var(--faint);opacity:.75}
  .task-reply h1,.task-reply h2,.task-reply h3,.task-reply h4,.task-reply h5,.task-reply h6{
    font-family:var(--font-ui);color:var(--brand);margin:var(--gap-head) 0 calc(var(--gap-block) / 2);
    line-height:var(--lh-tight)}
 /* mdToHtml 把 markdown 的 #/##/### 降两级映射到 h3/h4/h5(渲染层既有口径),
 故字号分级要按「真实 DOM 级别」给三档,否则 # 与 ## 在消息流里同字号(无层级感):
 h3(=md #)=正文×1.3 / h4(=md ##)=正文×1.15 / h5-h6(=md ###+)=正文;h1/h2 同档兜底。 */
  .task-reply h1,.task-reply h3{font-size:var(--fs-h1);font-weight:600}
  .task-reply h2,.task-reply h4{font-size:var(--fs-h2);font-weight:600}
  .task-reply h5,.task-reply h6{font-size:var(--fs-h3);font-weight:500}
  .task-reply h3{padding-left:9px;border-left:3px solid var(--bronze)}
  .task-reply h4{padding-left:8px;border-left:2px solid color-mix(in srgb,var(--bronze) 55%,transparent)}
  .task-reply p{margin:var(--gap-block) 0}
  .task-reply ul,.task-reply ol{margin:var(--gap-block) 0 var(--gap-block) var(--indent-1);padding-left:0}
  .task-reply ul ul,.task-reply ol ol,.task-reply ul ol,.task-reply ol ul{margin-left:var(--indent-2)}
  .task-reply ul ul ul,.task-reply ol ol ol,.task-reply ul ul ol,.task-reply ul ol ul,
  .task-reply ol ul ul,.task-reply ol ol ul,.task-reply ol ul ol,.task-reply ul ol ol{margin-left:var(--indent-3)}
  .task-reply li{margin:var(--gap-tool) 0;line-height:var(--lh-body)}
  .task-reply blockquote{margin:var(--gap-block) 0;padding:4px 12px 4px var(--indent-1);
    border-left:3px solid color-mix(in srgb,var(--bronze) 55%,transparent);
    background:var(--hover-bg);border-radius:0 7px 7px 0;color:var(--muted);
    font-size:var(--fs-body-sm);line-height:var(--lh-body)}
  .task-reply .md-hr,.task-reply hr{border:none;height:1px;margin:var(--gap-msg) 0;
    background:linear-gradient(90deg,color-mix(in srgb,var(--bronze) 45%,transparent),transparent)}
  .task-reply .code-wrap{letter-spacing:var(--ls-code)}
  .task-reply .code-wrap,.task-reply .td-mini,.task-reply .md-table{margin:var(--gap-block) 0}
  .task-reply mark{background:color-mix(in srgb,var(--bronze) 30%,transparent);color:var(--accent-bright);border-radius:3px;padding:0 2px}
 /* 工具卡=「底噪层」——比正文更沉、边更淡,让 AI 正文成为视觉重点;
 失败卡=浮起层(红边+红底),异常必须比正文更抢眼。
 工具卡标题行 --fs-tool + --font-mono;参数/摘要/结果体 --fs-code-sm;
 失败态只换 color(success/fail 同字号同行高,不允许靠字号区分)。 */
  .tool-card{border:1px solid var(--border-soft);border-radius:9px;margin:var(--gap-tool) 0;
    font-family:var(--font-mono);font-size:var(--fs-tool);line-height:var(--lh-tight);background:var(--surf-card)}
  .tool-card summary{cursor:pointer;padding:5px 10px;font-family:var(--font-mono);font-size:var(--fs-tool);
    line-height:var(--lh-tight);color:var(--muted);display:flex;gap:8px;align-items:center}
  .tool-card summary:hover{color:var(--text)}
  .tool-card .tc-body{padding:2px 10px 8px;font-family:var(--font-mono);font-size:var(--fs-code-sm);
    line-height:var(--lh-code);color:var(--faint);white-space:pre-wrap;word-break:break-word;max-height:280px;overflow-y:auto}
  .tool-card .tc-state{margin-left:auto;font-family:var(--font-mono);font-size:var(--fs-chip);line-height:var(--lh-tight)}
 /* 标题行里的参数/摘要(工具卡 .tc-args、分组项 .tg-args)统一 code-sm 档——全组同规格 */
  .tool-card .tc-args,.tg-head .tc-args{font-family:var(--font-mono);font-size:var(--fs-code-sm);line-height:var(--lh-tight);
    color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  .tc-ok{color:var(--green)} .tc-err{color:var(--red)}
 /* 工具结果展开全文(A):嵌套 details,免 JS 原生开合 */
  .tool-card .tr-more{margin:var(--gap-tool) 0 2px}
  .tool-card .tr-more summary{cursor:pointer;color:var(--bronze);padding:2px 0;
    font-size:var(--fs-tool);line-height:var(--lh-tight)}
  .tool-card .tr-more summary:hover{color:var(--accent-bright)}
  .tool-card .tr-full{max-height:420px}
 /* 工具结果行块(.tr-lines=逐行 .cl 结构;容器折叠裸换行,.cl display:block 承担换行) */
  .tr-lines .cl{display:block;white-space:pre-wrap}
  .tool-card .tc-body.tr-lines{white-space:normal;padding:4px 10px 6px}
  .tool-group .tg-item .code-wrap{margin:4px 0 2px}
  .tool-group .tg-item .tc-body{font-size:var(--fs-code-sm);line-height:var(--lh-code);max-height:240px;padding:4px 8px 6px}
  .tool-group .tg-item .tc-body.tr-lines{white-space:normal}
 /* fixH1:统一工具卡框架——图标+人话动词+参数摘要+状态徽标(运行中/完成/失败·耗时);失败卡红边 */
  .tool-card .tc-ic{width:12px;height:12px;vertical-align:-1.5px;opacity:.8;flex-shrink:0}
  .tool-card .tc-verb{color:var(--muted);flex-shrink:0;letter-spacing:.5px}
  .tc-state.tc-run{color:var(--warn)}
 /* 失败卡整卡浮红(底+边+头同色域),成功卡保持底噪层——一眼分清「出事的」和「跑过的」。
 失败态只换 color/底色/边,字号行高继承工具卡同一档(同型同规格)。 */
  .tool-card.tc-fail{border-color:color-mix(in srgb,var(--red) 55%,var(--border-soft));background:var(--surf-fail)}
  .tool-card.tc-fail>.summary, .tool-card.tc-fail>summary{color:var(--red)}
  .tg-head{display:flex;gap:7px;align-items:baseline;padding:3px 0 1px;font-family:var(--font-mono);
    font-size:var(--fs-tool);line-height:var(--lh-tight)}
  .tg-head .tc-ic{vertical-align:-1.5px}
  .tg-head .tg-st{margin-left:auto;font-size:var(--fs-chip);flex-shrink:0}
  .tg-head .tg-st.ok{color:var(--green)} .tg-head .tg-st.err{color:var(--red)}
 /* fixH1:专属结果体——chips 行/摘要计数(chip 固定档 --fs-chip) */
  .tr-chips{display:flex;flex-wrap:wrap;gap:4px 6px;margin:4px 0 6px;font-family:var(--font-mono)}
  .tr-chip{border:1px solid var(--border-soft);border-radius:6px;padding:1px 7px;font-size:var(--fs-chip);line-height:var(--lh-tight);color:var(--muted);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tr-chip b{color:var(--text);font-weight:600}
  .tr-chip.good{color:var(--green);border-color:var(--green)}
  .tr-chip.bad{color:var(--red);border-color:var(--red)}
  .tr-chip.note{color:var(--warn);border-color:var(--warn)}
  .tr-empty{color:var(--faint);font-family:var(--font-mono);font-size:var(--fs-code-sm);line-height:var(--lh-code);padding:2px 0}
 /* fixH2:grep/code_sense 命中——文件分组+行号 */
 /* 命中结果成「板」——每文件一组带米色底与左侧竖线,行内命中行加悬停,和正文文本区分开
 板内所有行同一档 --fs-code-sm + --lh-code(文件头/命中行/diff 行/诊断行不各写一套) */
  .gr-blk{background:var(--surf-hit);border:1px solid var(--border-soft);border-radius:8px;
    border-left:2px solid color-mix(in srgb,var(--bronze) 55%,transparent);padding:2px 0 4px;margin:var(--gap-tool) 0}
  .gr-file{margin:4px 0 1px;color:var(--bronze);font-size:var(--fs-code-sm);line-height:var(--lh-code);font-family:var(--font-mono);word-break:break-all;
    padding:2px 8px;background:color-mix(in srgb,var(--bronze) 7%,transparent);border-radius:4px}
  .gr-hit{display:flex;gap:8px;font-size:var(--fs-code-sm);line-height:var(--lh-code);font-family:var(--font-mono);padding:0 8px}
  .gr-hit:hover{background:var(--hover-bg)}
  .gr-hit .gr-ln{color:var(--faint);flex-shrink:0;min-width:28px;text-align:right}
  .gr-hit .gr-tx{min-width:0;word-break:break-all;white-space:pre-wrap}
 /* fixH2:glob/list_dir 文件行 */
  .dir-row{display:flex;gap:7px;align-items:center;font-size:var(--fs-code-sm);line-height:var(--lh-code);font-family:var(--font-mono);word-break:break-all}
  .dir-row .icn{width:11px;height:11px;vertical-align:-1px;opacity:.7;flex-shrink:0}
  .dir-row .dir-meta{margin-left:auto;color:var(--faint);font-size:var(--fs-chip);flex-shrink:0}
 /* fixH3:edit/write 迷你 diff(+绿/-红,主题变量跨 7 主题) */
 /* diff 板与终端板同族但走「增/删」语义色;尾部行号带用淡底分隔 */
  .td-mini{margin:var(--gap-tool) 0;border:1px solid var(--border-soft);border-radius:7px;overflow:hidden;
    font-family:var(--font-mono);font-size:var(--fs-code-sm);line-height:var(--lh-code);background:var(--surf-code)}
  .td-mrow{display:block;white-space:pre-wrap;word-break:break-all;font-size:var(--fs-code-sm);line-height:var(--lh-code);padding:0 8px}
  .td-mrow.add{color:var(--green);background:color-mix(in srgb,var(--green) 12%,transparent);box-shadow:inset 2px 0 0 color-mix(in srgb,var(--green) 60%,transparent)}
  .td-mrow.del{color:var(--red);background:color-mix(in srgb,var(--red) 12%,transparent);box-shadow:inset 2px 0 0 color-mix(in srgb,var(--red) 60%,transparent)}
 /* fixH4:terminal/run_cmd exit 徽标+输出(徽标=固定档 chip) */
  .tc-exit{font-family:var(--font-mono);font-size:var(--fs-chip);line-height:var(--lh-tight);padding:0 7px;border-radius:6px;border:1px solid var(--border-soft);color:var(--muted)}
  .tc-exit.z{color:var(--green);border-color:var(--green)}
  .tc-exit.n{color:var(--red);border-color:var(--red)}
 /* fixH5:诊断块(warn 调) */
  .diag-row{color:var(--warn);font-size:var(--fs-code-sm);line-height:var(--lh-code);white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono)}
  .diag-row.dg-err{color:var(--red,#e08a7a)}
 /* 诊断板(编辑/写入后的 LSP 反馈)——独立板式,error 级别整板加深,不再是「一行淡红字」 */
  .diag-box{margin:5px 0;border:1px solid color-mix(in srgb,var(--warn) 30%,var(--border-soft));
    border-left:2px solid color-mix(in srgb,var(--warn) 65%,transparent);border-radius:7px;
    background:color-mix(in srgb,var(--warn) 7%,transparent);padding:4px 8px}
  .diag-box.has-err{border-color:color-mix(in srgb,var(--red) 34%,var(--border-soft));
    border-left-color:color-mix(in srgb,var(--red) 70%,transparent);background:var(--surf-fail)}
  .diag-box .diag-hd{font-size:var(--fs-chip);line-height:var(--lh-tight);color:var(--muted);margin-bottom:2px;font-family:var(--font-mono)}
  .diag-box.has-err .diag-hd{color:var(--red)}
  .sub-bridge{border:1px dashed var(--bronze);border-radius:10px;margin:var(--gap-tool) 0;padding:8px 12px;background:rgba(201,162,94,.05)}
  .sub-bridge .sb-head{font-size:var(--fs-tool);color:var(--bronze);font-weight:700;display:flex;gap:8px;align-items:center}
  .sub-bridge .sb-hint{margin-left:auto;font-size:var(--fs-chip);color:var(--faint);font-weight:400}
  .sub-bridge .sb-req{font-family:var(--font-mono);font-size:var(--fs-code-sm);color:var(--muted);margin-top:6px;display:flex;gap:8px;align-items:baseline}
  .sub-bridge .sb-who{color:var(--text);font-weight:600;flex-shrink:0}
  .sub-bridge .sb-cmd{word-break:break-all}
 /* 通信卡结构化:动作徽标 + 参数行 + 原文折叠(全文 pre,纯文本) */
  .sub-bridge .sb-act{font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--accent-bright);flex-shrink:0;
    border:1px solid var(--bronze-dim);border-radius:6px;padding:0 5px;background:rgba(201,162,94,.08)}
  .sub-bridge .sb-args{font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--muted);margin:3px 0 0 0;
    padding-left:14px;display:flex;flex-wrap:wrap;gap:2px 12px}
  .sub-bridge .sb-args .sb-k{color:var(--faint)}
  .sub-bridge .sb-full{margin:3px 0 0 14px}
  .sub-bridge .sb-full summary{cursor:pointer;list-style:none;font-family:var(--font-mono);font-size:var(--fs-chip);color:var(--bronze-dim)}
  .sub-bridge .sb-full summary::before{content:"▸ "}
  .sub-bridge .sb-full[open] summary::before{content:"▾ "}
  .sub-bridge .sb-pre{font-family:var(--font-mono);font-size:var(--fs-code-sm);color:var(--muted);white-space:pre-wrap;
    word-break:break-word;max-height:240px;overflow:auto;border:1px dashed var(--border-soft);border-radius:6px;
    padding:4px 6px;margin:2px 0 0 0;background:rgba(0,0,0,.22)}
  .diag-row.dg-warn{color:var(--bronze)} .diag-row.dg-note{color:var(--muted)}
 /* fixH6:code_review 分级行 */
  .cr-sev{font-family:var(--font-mono);font-size:var(--fs-chip);padding:0 6px;border-radius:6px;border:1px solid var(--border-soft);color:var(--muted);flex-shrink:0}
  .cr-sev.hi{color:var(--red);border-color:var(--red)}
  .cr-sev.mid{color:var(--warn);border-color:var(--warn)}
  .cr-row{display:flex;gap:8px;align-items:baseline;padding:2px 0;font-size:var(--fs-code-sm);line-height:var(--lh-code)}
  .cr-row .cr-loc{color:var(--bronze);flex-shrink:0;font-size:var(--fs-code-sm);font-family:var(--font-mono)}
  .cr-row .cr-tx{min-width:0;word-break:break-word}
 /* fixH7:todo 计划进度 */
  .todo-meter{display:flex;gap:2px;height:4px;border-radius:2px;overflow:hidden;margin:5px 0 6px;max-width:240px}
  .todo-meter i{display:block;flex:1;background:var(--border-soft)}
  .todo-meter i.d{background:var(--green)} .todo-meter i.p{background:var(--warn)}
  .todo-row{display:flex;gap:7px;font-size:var(--fs-code-sm);line-height:var(--lh-code);align-items:baseline}
  .todo-row .td-mark{width:13px;flex-shrink:0;color:var(--faint)}
  .todo-row .td-mark .icn{width:11px;height:11px;vertical-align:-1px}
  .todo-row.d .td-mark{color:var(--green)} .todo-row.p .td-mark{color:var(--warn)}
  .todo-row.d .td-tx{color:var(--faint)}
 /* fixH8:board 节点行 */
  .bd-row{display:flex;gap:7px;font-size:var(--fs-code-sm);line-height:var(--lh-code);align-items:baseline}
  .bd-kind{border:1px solid var(--border-soft);border-radius:5px;padding:0 5px;font-size:var(--fs-chip);color:var(--muted);flex-shrink:0;font-family:var(--font-mono)}
  .bd-row .bd-tx{min-width:0;word-break:break-word}
 /* 语义着色 span(.cl 内切片;色值=--tok-* 七主题变量,缺席=纯文本零变化) */
  .cl .tk-func{color:var(--tok-func)}
  .cl .tk-type{color:var(--tok-type)}
  .cl .tk-var{color:var(--tok-var)}
  .cl .tk-num{color:var(--tok-num)}
  .cl .tk-str{color:var(--tok-str)}
  .cl .tk-bool{color:var(--tok-bool)}
  .cl .tk-enum{color:var(--tok-enum)}
  .cl .tk-lnno{color:var(--tok-comment)}        /* read_file 行号前缀(非代码调子) */
  .cl .tk-ptr{text-decoration:underline dotted var(--tok-comment);text-underline-offset:3px} /* 指针/数组标记 */
 /* 主题特征:glass 柔光 / ink 零装饰(浅色主题单色分层即语义) */
 /* 子代理过程卡(B):spawn 处内联,状态/耗时/tail */
 /* 过程卡再降一层(比工具卡更淡的底 + 角色色左边条加宽),层次=正文 > 失败卡 > 工具卡 > 过程卡
 全卡统一「从属档」--fs-code-sm + --lh-code(.sub-task/.sub-tail/.sub-polls/.sub-st 同档不跳),
 3px border-left 保留以呈现从属缩进;状态只换 color。 */
  .sub-card{border-left:3px solid var(--border-soft);background:color-mix(in srgb,var(--surf-card) 70%,transparent);
    font-family:var(--font-ui);font-size:var(--fs-code-sm);line-height:var(--lh-code)}
  .sub-card .sub-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .sub-card .sub-task{max-height:180px;overflow-y:auto}
  .sub-card .sub-dot.run{background:var(--warn);animation:stpulse 1.2s infinite}
  .sub-card .sub-dot.ok{background:var(--green)}
  .sub-card .sub-dot.fail{background:var(--red)}
  .sub-card .sub-dot.end{background:var(--faint)}
  .sub-card .sub-st{margin-left:auto;font-size:var(--fs-code-sm);line-height:var(--lh-code);font-family:var(--font-mono)}
  .sub-card .sub-st.run{color:var(--warn)} .sub-card .sub-st.ok{color:var(--green)} .sub-card .sub-st.fail{color:var(--red)} .sub-card .sub-st.end{color:var(--faint)}
  .sub-card .sub-task{color:var(--text);font-size:var(--fs-code-sm);line-height:var(--lh-code);padding:2px 10px 4px;font-family:var(--font-ui)}
  .sub-card .sub-tail{margin:2px 10px var(--gap-block);border:1px solid var(--border-soft);border-radius:7px;background:var(--surf-code);
    padding:6px 8px;font-family:var(--font-mono);font-size:var(--fs-code-sm);line-height:var(--lh-code);color:var(--muted);white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto}
 /* task_output 轮询聚合卡(刷屏治理):聚合说明行+等待卡头部标色 */
  .sub-card .sub-polls{margin:2px 10px var(--gap-block);font-family:var(--font-mono);font-size:var(--fs-code-sm);line-height:var(--lh-code);color:var(--faint)}
  .sub-card.sub-wait{border-left:2px solid var(--warn)}
  .sub-card.sub-wait.ok,.sub-card.sub-wait.fail{border-left-color:var(--border-soft)}
 /* 子智能体目录抽屉(ZCode SubagentDirectory 对齐):右侧滑出,两区+条目下钻;关闭钮复用 .sd-close */
  #subDir{position:fixed;right:0;top:0;bottom:0;width:min(440px,82vw);background:var(--window-bg,#141009);
    border-left:1px solid var(--border-soft);box-shadow:-20px 0 50px rgba(0,0,0,.5);z-index:76;
    display:flex;flex-direction:column;transform:translateX(105%);transition:transform .22s}
  #subDir.on{transform:none}
  .sd-title{font-size:12.5px;color:var(--brand);letter-spacing:1px}
  .sd-sub{font-family:var(--mono);font-size:10px;color:var(--faint)}
  .sd-body{flex:1;overflow-y:auto;padding:10px 12px}
  .sd-sec{margin-bottom:16px}
  .sd-sec-h{font-size:10.5px;color:var(--faint);letter-spacing:2px;margin-bottom:6px}
  .sd-empty{font-size:11px;color:var(--faint);padding:4px 2px}
  .sd-item{border:1px solid var(--border-soft);border-radius:9px;margin:0 0 6px;font-size:11px}
  .sd-item.ws-open{border-color:rgba(201,143,69,.45)}
 /* 条目主区域=一级入口(点击开/激活工作区 tab,tab 条在中间列顶部);下钻改挂「详情」钮轻展开 */
  .sd-item summary{cursor:pointer;padding:6px 10px;display:flex;gap:8px;align-items:center;font-family:var(--mono);color:var(--muted)}
  .sd-item summary:hover{color:var(--text);background:rgba(201,143,69,.06)}
  .sd-item .sd-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .sd-item .sd-dot.run{background:var(--warn);animation:stpulse 1.2s infinite}
  .sd-item .sd-dot.ok{background:var(--green)} .sd-item .sd-dot.fail{background:var(--red)} .sd-item .sd-dot.end{background:var(--faint)}
  .sd-item .sd-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sd-item .sd-role{color:var(--bronze);flex-shrink:0}
  .sd-item .sd-st{margin-left:auto;font-size:9px;flex-shrink:0}
  .sd-item .sd-st.run{color:var(--warn)} .sd-item .sd-st.ok{color:var(--green)} .sd-item .sd-st.fail{color:var(--red)} .sd-item .sd-st.end{color:var(--faint)}
 /* 目录深化(ZCode 条目密度对齐):摘要行下的元信息行(模型/deadline 倒计时/心跳)+运行条目「终止」按钮 */
  .sd-item summary{flex-wrap:wrap}
  .sd-item .sd-meta2{flex-basis:100%;display:flex;gap:10px;font-size:9.5px;color:var(--faint);font-family:var(--mono);padding-top:2px;min-width:0}
  .sd-item .sd-meta2 .sd-stale{color:var(--warn)}
  .sd-cancel{font-size:9.5px;font-family:var(--mono);border:1px solid var(--border-soft);color:var(--muted);background:transparent;border-radius:6px;padding:1px 8px;cursor:pointer;flex-shrink:0}
  .sd-cancel:hover{border-color:var(--red);color:var(--red)}
  .sd-cancel[disabled]{opacity:.5;cursor:default}
  .sd-final{margin-top:6px;border:1px solid var(--border-soft);border-radius:7px;background:rgba(0,0,0,.3);padding:6px 8px;
    font-family:var(--mono);font-size:10.5px;color:var(--text);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto}
  .sd-detail{padding:2px 10px 8px}
  .sd-model{font-family:var(--mono);font-size:10px;color:var(--bronze);padding:2px 0}
  .sd-task{max-height:200px;overflow-y:auto;color:var(--text);font-size:11px;white-space:pre-wrap;word-break:break-word;
    border:1px solid var(--border-soft);border-radius:7px;padding:6px 8px;background:rgba(0,0,0,.25);font-family:var(--sans)}
  .sd-tail{margin-top:6px;border:1px solid var(--border-soft);border-radius:7px;background:rgba(0,0,0,.3);padding:6px 8px;
    font-family:var(--mono);font-size:10.5px;color:var(--faint);white-space:pre-wrap;word-break:break-word;max-height:220px;overflow-y:auto}
  #subDirBadge{display:inline-block;min-width:14px;text-align:center;margin-left:5px;border-radius:999px;background:var(--warn);color:#1a120a;font-size:9px;padding:0 4px;font-family:var(--mono)}
 /* 子代理工作区 tab 条(点子代理弹它的完整工作区,如 vibe coding agent 工作区):
 中间工作区顶部一排 tab——「主会话」恒第一位不可关+每个打开的子代理工作区一个(状态点+标题+关闭);
 无工作区打开=整条隐藏。与已废弃硬隐藏的 #tabbar(会话标签条)不同 id 不冲突。 */
  #wsTabbar{display:none;gap:6px;align-items:center;padding:0 2px 8px;flex-wrap:wrap}
  #wsTabbar.on{display:flex}
  .ws-tab{display:inline-flex;gap:6px;align-items:center;max-width:240px;border:1px solid var(--border-soft);border-radius:999px;
    padding:3px 10px;font-size:11px;color:var(--muted);cursor:pointer;background:var(--glass);font-family:var(--mono)}
  .ws-tab:hover{color:var(--text);border-color:var(--bronze-dim)}
  .ws-tab.on{color:var(--bronze);border-color:var(--bronze);background:rgba(201,143,69,.08)}
  .ws-tab .wt-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .ws-tab .wt-dot.run{background:var(--warn);animation:stpulse 1.2s infinite}
  .ws-tab .wt-dot.ok{background:var(--green)} .ws-tab .wt-dot.fail{background:var(--red)} .ws-tab .wt-dot.end{background:var(--faint)}
  .ws-tab .wt-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ws-tab .wt-x{border:none;background:transparent;color:var(--faint);cursor:pointer;font-size:12px;padding:0 1px;line-height:1}
  .ws-tab .wt-x:hover{color:var(--red)}
 /* 工作区体(tab 激活时占据 chatBody 同一滚动容器;渲染器复用主历史全套) */
  .ws-head{border:1px solid var(--border-soft);border-radius:11px;padding:10px 12px;margin:4px 0 12px;background:rgba(28,18,10,.4)}
  .ws-head .ws-title{font-size:13px;color:var(--brand);display:flex;gap:8px;align-items:center}
  .ws-head .ws-title .wt-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .ws-head .ws-title .wt-dot.run{background:var(--warn);animation:stpulse 1.2s infinite}
  .ws-head .ws-title .wt-dot.ok{background:var(--green)} .ws-head .ws-title .wt-dot.fail{background:var(--red)} .ws-head .ws-title .wt-dot.end{background:var(--faint)}
  .ws-head .ws-meta{font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:4px;display:flex;gap:12px;flex-wrap:wrap}
  .ws-head .ws-task{margin-top:6px;max-height:160px;overflow-y:auto;color:var(--text);font-size:11px;white-space:pre-wrap;word-break:break-word;
    border:1px solid var(--border-soft);border-radius:7px;padding:6px 8px;background:rgba(0,0,0,.25)}
  .ws-head .ws-final{margin-top:6px;border:1px solid rgba(157,192,139,.35);border-radius:7px;background:rgba(0,0,0,.25);padding:6px 8px;
    font-size:11.5px;color:var(--text);white-space:pre-wrap;word-break:break-word;max-height:260px;overflow-y:auto}
  .ws-omitted{font-family:var(--mono);font-size:10px;color:var(--faint);border:1px dashed var(--border-soft);border-radius:8px;padding:5px 10px;margin:4px 0 10px;display:flex;gap:10px;align-items:center}
  .ws-omitted button{border:1px solid var(--border-soft);background:transparent;color:var(--bronze);border-radius:6px;font-size:10px;padding:1px 8px;cursor:pointer}
  .ws-step{font-family:var(--mono);font-size:10px;color:var(--faint);padding:1px 0 1px 4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .ws-step b{color:var(--bronze);font-weight:400;flex-shrink:0}
  .ws-timeline{border:1px solid var(--border-soft);border-radius:9px;background:rgba(0,0,0,.3);padding:8px 10px;
    font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:pre-wrap;word-break:break-word;max-height:520px;overflow-y:auto}
  .ws-note{font-size:10.5px;color:var(--faint);font-family:var(--mono);padding:2px 4px 8px}
  .sd-open{font-size:9.5px;font-family:var(--mono);border:1px solid var(--border-soft);color:var(--bronze);background:transparent;border-radius:6px;padding:1px 8px;cursor:pointer;flex-shrink:0}
  .sd-open:hover{border-color:var(--bronze)}
 /* spawn 过程卡的「工作区」按钮(消息流内就地开 tab,与目录条目行同一 data-subws 委托) */
  .sc-ws{font-size:9px;font-family:var(--mono);border:1px solid var(--border-soft);color:var(--bronze);background:transparent;border-radius:6px;padding:0 7px;cursor:pointer;flex-shrink:0}
  .sc-ws:hover{border-color:var(--bronze)}
 /* 工作区头部「终止」按钮(运行中且注册表在场才渲染;复用 data-subcancel 全局委托) */
  .ws-head .ws-title .sd-cancel{margin-left:auto}
 /* 删除会话流顶部置顶条(#chatTopbar)。它空着也占 14px 灰线、chips 一多就折行
 (8px→40px+),随 3s session.status 轮询反复出现/消失,把会话流消息上下顶(用户实报「这条线周期变两条」)。
 chips 改挂 footer 底部状态条 .aff-strip:不在滚动容器内,单行不折(nowrap+横向滚动),高度只在真有 chips 时出现。 */
  #chatStatusbar{display:flex;flex-wrap:nowrap;gap:6px;font-size:11px;align-items:center;min-width:0;flex:0 1 auto;
                 overflow-x:auto;overflow-y:hidden;scrollbar-width:none;min-height:22px}
  #chatStatusbar::-webkit-scrollbar{display:none}
 /* 空态也占住 chip 行高(22px):chips 随 3s 轮询出现/消失时 footer 高度分毫不变 → composer 与消息区零位移 */
  #chatStatusbar>*{flex:0 0 auto;white-space:nowrap}
 /* 清单展开浮层:底部条内不能再占行(旧 width:100% 会把 chips 顶成两行),改浮在 footer 之上 */
  #chatStatusbar .todo-pop{position:absolute;bottom:100%;left:0;width:min(460px,92vw);margin-bottom:6px;
                           background:var(--window-bg,#141009);z-index:30;max-height:40vh;overflow-y:auto}
 /* fixT6 P1:失败常驻提示 chip(footer 状态条内=恒在视口,见 renderStatusbar 说明)。
 review 修正:边框/悬停底原写死 rgba(224,138,122,…)(=dark 的 --red),浅色主题(ink/light,--red:#b8543f)
 chip 会按暗色红渲染——改 color-mix 由 var(--red) 派生(七套主题自动跟随)。 */
  .st-chip.st-err{border-color:color-mix(in srgb,var(--red) 50%,transparent);color:var(--red);cursor:pointer}
  .st-chip.st-err b{color:var(--red)}
  .st-chip.st-err:hover{background:color-mix(in srgb,var(--red) 12%,transparent)}
 /* batch1b 重试条:与失败条同族但走 bronze 提示色(「还在重试」不是失败,别用红)。 */
  .st-chip.st-retry{border-color:color-mix(in srgb,var(--bronze) 55%,transparent);color:var(--bronze)}
  .st-chip{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--border-soft);border-radius:999px;padding:2px 10px;color:var(--muted);font-family:var(--font-mono);font-size:var(--fs-chip)}
  .st-chip b{color:var(--bronze)}
  .todo-pop{width:100%;border:1px solid var(--border-soft);border-radius:9px;padding:6px 10px;font-size:11px;color:var(--muted)}
  .todo-pop .ti{display:flex;gap:8px;padding:2px 0}
  .todo-pop .ti.done span{text-decoration:line-through;color:var(--faint)}
  .todo-pop .ti.cur span{color:var(--bronze)}
  .err-banner{border:1px solid var(--red);border-radius:9px;padding:8px 12px;margin:6px 0;font-size:12px;color:var(--red)}
  .err-banner .btns{margin-top:6px;display:flex;gap:8px}
  .err-banner button{background:transparent;border:1px solid var(--red);color:var(--red);border-radius:7px;font-size:11px;padding:3px 12px;cursor:pointer}
  .find-bar{display:flex;gap:6px;align-items:center;padding:4px 10px;border:1px solid var(--border-soft);border-radius:9px;margin-bottom:8px}
  .find-bar input{background:transparent;border:0;outline:none;color:var(--text);font-size:12px;flex:1}
  .find-bar button{background:transparent;border:1px solid var(--border-soft);color:var(--muted);border-radius:6px;cursor:pointer;font-size:11px;padding:1px 8px}
  .find-count{font-size:10px;color:var(--faint);font-family:var(--mono)}
  mark{background:var(--bronze-glow);color:var(--text);border-radius:3px;padding:0 2px}
 /* 权限审批对话框( B2,ZCode PermissionDialog 裁剪) */
  #permDialog{position:fixed;inset:0;background:var(--overlay);display:none;align-items:center;justify-content:center;z-index:80}
  #permDialog.on{display:flex}
  .perm-box{width:420px;background:var(--window-bg,#141009);border:1px solid var(--border);border-radius:14px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.6)}
  .perm-box h3{font-size:13px;color:var(--brand);margin-bottom:8px;letter-spacing:1px}
  .perm-tool{font-family:var(--mono);font-size:11px;color:var(--bronze);margin-bottom:6px}
  .perm-sum{font-size:12px;color:var(--reply);background:rgba(0,0,0,.3);border-radius:8px;padding:8px 10px;margin-bottom:8px;
    font-family:var(--mono);white-space:pre-wrap;word-break:break-word;max-height:140px;overflow-y:auto}
  .perm-meta{font-size:10px;color:var(--faint);margin-bottom:12px;font-family:var(--mono)}
  .perm-btns{display:flex;gap:10px}
  .perm-btns button{flex:1;padding:8px 0;border-radius:9px;font-size:12px;cursor:pointer;letter-spacing:1px}
  .perm-allow{border:1px solid var(--green);color:var(--green);background:transparent}
  .perm-allow:hover{background:rgba(157,192,139,.12)}
  .perm-deny{border:1px solid var(--border-soft);color:var(--muted);background:transparent}
  .perm-deny:hover{border-color:var(--red);color:var(--red)}
 /* Git 面板(批C) */
  .git-bar{display:flex;gap:10px;align-items:center;margin-bottom:10px}
  .git-branch{font-family:var(--mono);font-size:12px;color:var(--bronze)}
  .git-bar select,.git-bar button{background:var(--glass);border:1px solid var(--border-soft);border-radius:9px;color:var(--text);font-size:11px;padding:5px 10px;outline:none}
  .git-main{flex:1;display:flex;gap:12px;min-height:0}
  .git-changes{flex:0 0 240px;overflow-y:auto;font-family:var(--mono);font-size:11px}
  .git-ch{padding:5px 8px;border-radius:7px;cursor:pointer;color:var(--muted);display:flex;gap:6px;align-items:center}
  .git-ch:hover,.git-ch.on{background:var(--accent-soft);color:var(--text)}
  .git-ch .g-label{font-size:9px;color:var(--faint)}
  .git-ch .g-staged{color:var(--green)}
  .git-diff{flex:1;overflow:auto;font-family:var(--mono);font-size:11px;line-height:1.6;
    border:1px solid var(--border-soft);border-radius:10px;padding:8px 12px;white-space:pre-wrap;word-break:break-word}
  .d-add{color:var(--green)} .d-del{color:var(--red)} .d-hunk{color:var(--bronze)} .d-meta{color:var(--faint)}
  .git-commit{display:flex;gap:10px;margin-top:10px}
  .git-commit input{flex:1;background:rgba(0,0,0,.3);border:1px solid var(--border-soft);border-radius:9px;color:var(--text);font-size:12px;padding:7px 10px;outline:none}
  .git-commit button{background:transparent;border:1px solid var(--border-soft);border-radius:9px;color:var(--text);font-size:11px;padding:0 16px;cursor:pointer}
  .git-commit button:hover{border-color:var(--bronze);color:var(--bronze)}
 /* F1 多快照浏览:git 视图快照区 */
  .snap-sec{margin-top:14px;border-top:1px solid var(--border-soft);padding-top:10px}
  .snap-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .snap-head .vw-act{margin-left:0}
 /* F3 任务行操作:右键菜单+置顶区+归档视图 */
  #selMenu{position:fixed;display:none;gap:6px;background:var(--window-bg,#141009);border:1px solid var(--border);
    border-radius:9px;padding:4px;z-index:72;box-shadow:0 8px 24px rgba(0,0,0,.5)}
  #selMenu button{background:transparent;border:0;color:var(--muted);font-size:11px;padding:4px 8px;cursor:pointer;border-radius:6px}
  #selMenu button:hover{background:var(--accent-soft);color:var(--text)}
  #taskMenu{position:fixed;display:none;background:var(--window-bg,#141009);border:1px solid var(--border);
    border-radius:10px;box-shadow:0 10px 36px rgba(0,0,0,.55);padding:4px;z-index:70;min-width:130px}
  .tm-item{padding:6px 12px;font-size:11.5px;color:var(--muted);cursor:pointer;border-radius:7px}
  .tm-item:hover{background:var(--accent-soft);color:var(--text)}
  .t-pin{color:var(--bronze);font-size:9px;margin-right:4px}
  .sb-tt.arch-on{color:var(--bronze);border-bottom:1px solid var(--bronze)}
 /* F4 file:line citation */
  a.cite{font-family:var(--mono);font-size:.92em;color:var(--green);text-decoration:none;border-bottom:1px dashed var(--green);cursor:pointer}
  a.cite:hover{color:var(--text);border-color:var(--text)}
 /* 聊天正文文件路径(裸路径/markdown 相对链接)→ 点击在 IDE 打开 */
  a.chat-file{font-family:var(--mono);font-size:.94em;color:var(--bronze);text-decoration:none;
    border-bottom:1px dotted var(--bronze);cursor:pointer;word-break:break-all}
  a.chat-file:hover{color:var(--text);border-color:var(--text)}
  #fileViewer{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;z-index:75;align-items:center;justify-content:center}
  #fileViewer.on{display:flex}
  .fv-box{width:72%;max-height:78vh;background:var(--window-bg,#141009);border:1px solid var(--border);border-radius:14px;
    box-shadow:0 18px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden}
  .fv-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--border-soft)}
  .fv-path{font-family:var(--mono);font-size:12px;color:var(--bronze);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fv-close{background:transparent;border:1px solid var(--border-soft);color:var(--muted);border-radius:7px;font-size:11px;padding:2px 10px;cursor:pointer}
  .fv-body{overflow:auto;padding:10px 0;font-family:var(--mono);font-size:11.5px;line-height:1.7}
  .fv-line{display:flex;padding:0 16px}
  .fv-line .ln{width:44px;flex-shrink:0;color:var(--faint);text-align:right;padding-right:12px;user-select:none}
  .fv-line.hl{background:var(--accent-soft)}
  .fv-line.hl .ln{color:var(--bronze)}
 /* ── 添加项目重做(打开文件夹=服务端目录浏览器 / 远程连接向导) ── */
  .proj-add-quick{display:flex;gap:6px;margin-bottom:6px}
  .proj-add-quick button{flex:1;background:var(--accent-soft);border:1px solid var(--border-soft);color:var(--text);
    border-radius:8px;font-size:11px;padding:5px 4px;cursor:pointer}
  .proj-add-quick button:hover{border-color:var(--bronze);color:var(--bronze)}
  #dirBrowser,#projRemote{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;z-index:80;align-items:center;justify-content:center}
  #dirBrowser.on,#projRemote.on{display:flex}
  .db-card{width:520px;max-width:92vw;max-height:76vh;background:var(--window-bg,#141009);border:1px solid var(--border);border-radius:14px;
    box-shadow:0 18px 60px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden}
  .db-head{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border-soft);font-size:13px;color:var(--text)}
  .db-path-row{display:flex;gap:6px;padding:10px 16px 4px}
  .db-path-row button{background:transparent;border:1px solid var(--border-soft);color:var(--muted);border-radius:7px;font-size:11px;padding:3px 10px;cursor:pointer}
  .db-path-row button:hover{color:var(--text)}
  .db-path-row input{flex:1;background:var(--input-bg);border:1px solid var(--border-soft);border-radius:7px;color:var(--text);
    font-family:var(--mono);font-size:11.5px;padding:4px 8px;outline:none}
  .db-quick{display:flex;align-items:center;gap:12px;padding:6px 16px;font-size:11px;color:var(--muted)}
  .db-anchor{cursor:pointer;padding:1px 6px;border-radius:6px}
  .db-anchor:hover{background:rgba(255,255,255,.06);color:var(--text)}
  .db-hidden{display:flex;align-items:center;gap:4px;cursor:pointer}
  .db-err{color:var(--red);margin-left:auto;font-size:10.5px}
  .db-list{flex:1;overflow:auto;min-height:220px;max-height:46vh;padding:4px 8px}
  .db-row{display:flex;align-items:center;gap:8px;padding:4px 10px;border-radius:7px;font-size:12px;color:var(--muted);cursor:pointer}
  .db-row:hover{background:rgba(255,255,255,.05)}
  .db-row.sel{background:var(--accent-soft);color:var(--text)}
  .db-row .ic{width:14px;text-align:center;flex-shrink:0}
  .db-row.file{color:var(--faint);cursor:default}
  .db-row .mt{margin-left:auto;font-size:10px;color:var(--faint)}
  .db-foot{display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--border-soft)}
  .db-sel{flex:1;font-family:var(--mono);font-size:11px;color:var(--bronze);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pr-cards{display:flex;gap:10px;padding:14px 16px 6px}
  .pr-card{flex:1;border:1px solid var(--border-soft);border-radius:10px;padding:10px 8px;text-align:center;cursor:pointer;color:var(--muted)}
  .pr-card b{display:block;font-size:13px;color:var(--text);margin-bottom:3px}
  .pr-card span{font-size:10px}
  .pr-card:hover{border-color:var(--bronze)}
  .pr-card.on{border-color:var(--bronze);background:var(--accent-soft)}
  .pr-form{display:flex;flex-direction:column;gap:8px;padding:10px 16px 16px}
  .pr-form .row{display:flex;gap:8px}
  .pr-form input{flex:1;background:rgba(0,0,0,.3);border:1px solid var(--border-soft);border-radius:7px;color:var(--text);
    font-size:11.5px;padding:5px 8px;outline:none;min-width:0}
  .pr-form .note{font-size:10.5px;color:var(--faint);line-height:1.6}
  .pr-form .go{background:var(--accent-soft);border:1px solid var(--bronze);color:var(--bronze);border-radius:8px;
    font-size:11.5px;padding:5px 14px;cursor:pointer;align-self:flex-start}
 /* ── 项目文件树视图 ── */
  .files-tree{flex:1;overflow:auto;padding:6px 4px;font-size:12px}
  .ft-row{display:flex;align-items:center;gap:6px;padding:3px 10px;border-radius:7px;color:var(--muted);cursor:pointer;white-space:nowrap}
  .ft-row:not(.sel):hover{background:var(--hover-bg2);box-shadow:inset 2px 0 0 var(--bronze)}
  .ft-row.sel:hover{background:var(--accent-soft);box-shadow:none}
  .ft-row .chev{width:12px;flex-shrink:0;font-size:9px;color:var(--faint);text-align:center}
  .ft-row .ic{width:15px;text-align:center;flex-shrink:0}
  .ft-row .nm{overflow:hidden;text-overflow:ellipsis}
  .ft-row.dir .nm{color:var(--text)}
  .ft-row.sel{background:var(--accent-soft)}
 /* ── 侧栏分桶折叠(项目内 session 可折叠) ── */
  .t-bh{display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none}
  .t-bh:hover{color:var(--muted)}
  .t-bh .bh-chev{font-size:8px;width:10px;display:inline-block}
  .t-bh .bh-ct{margin-left:auto;font-size:9px;color:var(--faint);letter-spacing:0}
  .proj-row .p-more{opacity:0;cursor:pointer;font-size:12px;padding:0 3px;transition:opacity .12s}
  .proj-row:hover .p-more{opacity:1}
  .proj-row .p-more:hover{color:var(--bronze)}
 /* F6 workflow 面板直答 */
  .wf-q{border:1px solid var(--warn);border-radius:10px;padding:8px 12px;margin:4px 0;font-size:11px}
  .wf-q .q-txt{color:var(--muted);margin-bottom:6px;font-family:var(--mono)}
  .wf-q .q-row{display:flex;gap:8px}
  .wf-q input{flex:1;background:rgba(0,0,0,.3);border:1px solid var(--border-soft);border-radius:7px;color:var(--text);font-size:11px;padding:4px 8px;outline:none}
  .wf-q button{background:transparent;border:1px solid var(--warn);color:var(--warn);border-radius:7px;font-size:11px;padding:2px 12px;cursor:pointer}
 /* 代码评论卡(ZCode AssistantCodeCommentCards 移植) */
  .rev-group{border:1px solid var(--border-soft);border-radius:11px;margin:6px 0;overflow:hidden}
  .rev-head{padding:7px 12px;font-size:11px;color:var(--bronze);cursor:pointer;background:var(--accent-soft)}
  .rev-card{display:flex;gap:10px;padding:7px 12px;border-top:1px solid var(--border-soft);cursor:pointer;align-items:baseline}
  .rev-card:hover{background:rgba(255,255,255,.04)}
  .rev-sev{font-family:var(--mono);font-size:10px;flex-shrink:0;padding:1px 7px;border-radius:6px;border:1px solid}
  .rev-sev.p0,.rev-sev.P0,.rev-sev.blocker{color:var(--red);border-color:var(--red)}
  .rev-sev.p1,.rev-sev.P1{color:var(--warn);border-color:var(--warn)}
  .rev-sev.p2,.rev-sev.P2,.rev-sev.info,.rev-sev.nit{color:var(--muted);border-color:var(--border-soft)}
  .rev-loc{font-family:var(--mono);font-size:10.5px;color:var(--green);flex-shrink:0}
  .rev-title{font-size:11.5px;color:var(--text)}
  .rev-detail{font-size:10.5px;color:var(--faint);margin-top:2px}
 /* 评审评论一键回注:单条/整批注入聊天窗 */
  .rev-inj,.rev-inj-all{background:transparent;border:1px solid var(--bronze);color:var(--bronze);border-radius:7px;font-size:10px;padding:1px 8px;cursor:pointer;flex-shrink:0;white-space:nowrap}
  .rev-inj:hover,.rev-inj-all:hover{background:rgba(200,143,69,.15)}
  .rev-inj-all{margin-left:8px}
  .rev-sel{flex-shrink:0;accent-color:var(--bronze);cursor:pointer;align-self:center}
  .rev-store-bar{display:flex;gap:8px;margin:4px 0 6px;align-items:center}
  .rev-store-bar button{background:transparent;border:1px solid var(--bronze);color:var(--bronze);border-radius:7px;font-size:11px;padding:2px 10px;cursor:pointer}
  .rev-store-bar button:hover{background:rgba(200,143,69,.15)}
  .rev-store-bar button:disabled{opacity:.45;cursor:default}
  #revInjMask{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;z-index:76;align-items:center;justify-content:center}
  #revInjMask.on{display:flex}
  .rij-box{width:520px;max-width:92vw}
  .rij-body{padding:12px 16px;display:flex;flex-direction:column;gap:8px;max-height:70vh;overflow:auto}
  .rij-count{font-size:12px;color:var(--bronze)}
  .rij-item{font-size:11.5px;color:var(--text);padding:3px 0;border-bottom:1px dashed var(--border-soft);font-family:var(--mono)}
  .rij-more{font-size:10.5px;color:var(--faint)}
  .rij-target{font-size:11px;color:var(--muted);margin-top:4px}
  .rij-opt{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text);cursor:pointer;padding:2px 0}
  .rij-note{width:100%;background:rgba(0,0,0,.3);border:1px solid var(--border-soft);border-radius:7px;color:var(--text);font-size:11.5px;padding:5px 8px;outline:none;box-sizing:border-box}
  .rij-go{align-self:flex-end;background:transparent;border:1px solid var(--bronze);color:var(--bronze);border-radius:8px;font-size:12px;padding:4px 18px;cursor:pointer}
  .rij-go:hover{background:rgba(200,143,69,.18)}
 /* 消息动作钮(ZCode edit/fork 移植);侧聊已改走 super agent(sideToSuper,独立抽屉退役);
 .sd-close 保留=通用抽屉关闭钮(diff 抽屉在用) */
  .sd-close{background:transparent;border:1px solid var(--border-soft);color:var(--muted);border-radius:7px;font-size:11px;padding:2px 10px;cursor:pointer}
  .msg-acts{display:inline-flex;gap:6px;margin-left:10px;opacity:0;transition:.15s}
  .user-line:hover .msg-acts,.t-row:hover .msg-acts{opacity:1}
  .msg-acts button{background:transparent;border:1px solid var(--border-soft);color:var(--faint);border-radius:6px;font-size:9px;padding:1px 7px;cursor:pointer}
  .msg-acts button:hover{color:var(--bronze);border-color:var(--bronze)}
 /* 自动化管理/toast/模型快切/跳轮 */
  .auto-sec{border:1px solid var(--border-soft);border-radius:11px;padding:10px 12px;margin-bottom:10px}
  .auto-row{display:flex;gap:8px;align-items:center;padding:5px 0;font-size:11px;border-top:1px solid var(--border-soft)}
  .auto-row:first-of-type{border-top:0}
  .auto-row .a-name{color:var(--text);flex:0 0 110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .auto-row .a-meta{color:var(--faint);font-family:var(--mono);font-size:10px;flex:1}
  .auto-row button{background:transparent;border:1px solid var(--border-soft);color:var(--muted);border-radius:6px;font-size:10px;padding:1px 8px;cursor:pointer}
  .auto-row button:hover{color:var(--bronze);border-color:var(--bronze)}
  .auto-row button.off{color:var(--faint)}
  .auto-form{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
  .auto-form input{background:var(--input-bg);border:1px solid var(--border-soft);border-radius:7px;color:var(--text);font-size:11px;padding:4px 8px;outline:none}
  .auto-form input[name=name]{width:110px}
  .auto-form input[name=every]{width:70px}
  .auto-form input[name=instruction]{flex:1;min-width:160px}
  #toastHost{position:fixed;right:18px;bottom:calc(var(--bnav-h,44px) + 14px);display:flex;flex-direction:column;gap:8px;z-index:85} /* :经典态同样避让底部导航条(画布态已由 canvas-shell ⑧ 修,agent 红线未覆盖经典) */
 /* 经典聊天态:toast 同样上移——开屏「权限模型已同步」等提示曾整块压住模型/力度/发送按钮。 */
  body[data-view="chat"]:not(.cv-shell) #toastHost{bottom:calc(var(--bnav-h,44px) + 240px)}
 /* 右侧 diff 抽屉( F1,参考「从右边弹出展示修改了什么」):变更条文件→单文件补丁 */
  #dd{position:fixed;right:0;top:0;bottom:0;width:min(640px,55vw);background:var(--window-bg,#141009);
      border-left:1px solid var(--border-soft);box-shadow:-20px 0 50px rgba(0,0,0,.5);z-index:75;
      display:flex;flex-direction:column;transform:translateX(105%);transition:transform .22s}
  #dd.on{transform:none}
  .dd-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border-soft)}
  .dd-title{font-family:var(--mono);font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dd-body{flex:1;overflow:auto;font-family:var(--mono);font-size:11px;line-height:1.75;padding:10px 14px}
  .dd-body span{display:block;white-space:pre-wrap;word-break:break-all}
  .dl-add{color:#7bd88f;background:rgba(90,200,120,.08)}
  .dl-del{color:#e08585;background:rgba(220,90,90,.08)}
  .dl-hunk{color:#7fa7d9}
  .dl-meta{color:var(--faint)}
 /* 变更条内联文件清单(点击就地列出修改了什么) */
  .filelist{margin:2px 0 4px 6px;border-left:2px solid var(--border-soft);padding-left:10px;display:flex;flex-direction:column;gap:2px}
  .fl-row{display:flex;align-items:center;gap:10px;cursor:pointer;padding:2px 8px;border-radius:6px;font-family:var(--mono);font-size:11px;color:var(--muted);max-width:680px}
  .fl-row:hover{background:rgba(255,255,255,.05);color:var(--text)}
  .fl-row.on{background:rgba(201,143,69,.10);color:var(--accent-bright)}
  .fl-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fl-row .da{color:#7bd88f}.fl-row .dd{color:#e08585}
  .mr-tag.mr-ok{color:#7bd88f;border-color:rgba(123,216,143,.4)}
  .mr-tag.mr-bad{color:#e08585;border-color:rgba(224,133,133,.4)}
  .mr-tag.mr-probe{color:var(--bronze)}
  .toast{background:var(--window-bg,#141009);border:1px solid var(--border);border-left:3px solid var(--bronze);
    border-radius:10px;padding:9px 14px;font-size:12px;color:var(--text);box-shadow:0 8px 28px rgba(0,0,0,.5);max-width:320px}
  .toast.err{border-left-color:var(--red)}
  .toast-copy{margin-left:10px;background:none;border:1px solid var(--border);border-radius:6px;color:var(--bronze);font-size:11px;padding:1px 6px;cursor:pointer;font-family:var(--sans)}
  .toast-copy:hover{border-color:var(--bronze);color:var(--accent-bright)}
  .toast.warn{border-left-color:var(--warn);color:var(--text)} /* n8:成功但带 warning(可落盘、任务执行未必使用)= 黄色轻提示,不冒充失败 */
 /* ===== u1 模型选择器 = ZCode ModelConfigSelect 触发器(v4/composer/V4ComposerToolbar.tsx:1043):
 ghost Button(h-7 rounded-lg px-2 gap-1 text-ui-base),无边框无药丸底;三段=模型图标 size-4 / 滚动文案 / chevron size-3.5。
 文案=providerName/ 前缀(独立 span,空间不足先隐藏)+ 模型名 truncate —— 旧「主模型:」前缀文字彻底去掉。 ===== */
  .model-trigger{height:28px;border-radius:8px;padding:0 6px 0 8px;display:inline-flex;align-items:center;gap:4px;
    background:transparent;border:none;font-family:var(--sans);font-size:12.5px;color:var(--text);cursor:pointer;
    max-width:320px;min-width:0;white-space:nowrap;transition:background .15s}
  .model-trigger:hover{background:var(--hover-bg)}
  .model-trigger:focus-visible{outline:1px solid var(--bronze);outline-offset:1px}
  .model-trigger .mt-icon{display:inline-flex;align-items:center;flex-shrink:0;color:var(--muted)}
  .model-trigger .mt-icon .icn{width:16px;height:16px}
 /* u2 文案滚动:height 1.3em + overflow hidden 做「卷轴窗」,切换时新文案自下方 0.75em 滑入(纯 CSS transition) */
  .model-trigger .mt-label{min-width:0;height:1.3em;overflow:hidden;display:inline-flex;align-items:center;line-height:1.25}
  .model-trigger .mt-roll{position:relative;display:block;min-width:0;overflow:hidden}
  .model-trigger .mt-roll-in{display:flex;min-width:0;align-items:center;transform:translateY(0);opacity:1;
    transition:transform .2s cubic-bezier(.4,0,.2,1),opacity .2s cubic-bezier(.4,0,.2,1)}
  .model-trigger .mt-roll-in.mt-out{position:absolute;left:0;top:0;right:0}
  .model-trigger .mt-provider{flex-shrink:0;color:var(--faint)}
  .model-trigger .mt-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .model-trigger .mt-chev{display:inline-flex;align-items:center;flex-shrink:0;color:var(--faint)}
  .model-trigger .mt-chev .icn{width:14px;height:14px}
  .model-trigger .mt-spin{width:14px;height:14px;flex-shrink:0;border-radius:50%;border:1.5px solid var(--bronze);
    border-top-color:transparent;animation:mp-spin .8s linear infinite}
  @keyframes mp-spin{to{transform:rotate(360deg)}}
 /* n8 staged 态保留语义但换 zcode 形态:不再虚线药丸,只靠字色 + chevron→转轮(见 mt-spin) */
  .model-trigger.staged{color:var(--bronze)}
  .model-trigger.staged-err{color:var(--red)}
  .model-trigger .mt-err{color:var(--red);font-size:12.5px;cursor:pointer}
  .model-trigger .mt-empty{color:var(--muted);font-size:12.5px}
 /* ===== u3 思考档位 = ZCode ThoughtLevelCycleControl(chat-input-toolbar):独立 ghost 按钮,
 脑图标 size-4 + 竖向进度条(w-1 self-stretch bg-current/10,内层 bg-success 高度=档位百分比 300ms 回弹) + 档位文案 ===== */
  .thought-btn{height:28px;border-radius:8px;padding:0 6px;display:inline-flex;align-items:center;gap:4px;
    background:transparent;border:none;font-family:var(--sans);font-size:12.5px;color:var(--text);cursor:pointer;white-space:nowrap;transition:background .15s}
  .thought-btn:hover{background:var(--hover-bg)}
  .thought-btn:focus-visible{outline:1px solid var(--bronze);outline-offset:1px}
  .thought-btn .tb-icon{display:inline-flex;align-items:center;flex-shrink:0;color:var(--muted)}
  .thought-btn .tb-icon .icn{width:16px;height:16px}
  .thought-btn .tb-bar{width:4px;align-self:stretch;margin:4px 0;border-radius:999px;background:rgba(255,255,255,.1);
    display:inline-flex;align-items:flex-end;overflow:hidden;flex-shrink:0}
  .thought-btn .tb-fill{width:100%;min-height:2px;border-radius:999px;background:var(--green);
    transition:height .3s cubic-bezier(.34,1.56,.64,1)}
  .thought-btn .tb-text{color:var(--muted)}
  .thought-btn.on .tb-text{color:var(--text)}
 /* ===== u5 弹层骨架(ZCode ModelConfigSelect DropdownMenuContent:side=top/align=start/sideOffset=2、
 avoidCollisions、无遮罩、z-[60]、p-1 gap-0.5 rounded-lg border shadow-md) ===== */
  .pill-menu{position:fixed;z-index:60;display:flex;flex-direction:column;gap:2px;
    background:var(--window-bg,#141009);border:1px solid var(--border-soft);border-radius:8px;
    box-shadow:0 12px 32px rgba(0,0,0,.5);padding:4px;width:max-content;min-width:160px;
    max-height:min(360px,calc(100vh - 120px));overflow-y:auto}
 /* 有二级(provider 分组)时按内容宽展开;无二级固定 192px(12rem)/288px(18rem) 高度上限 */
  .pill-menu.has-sub{min-width:192px;width:max-content;max-width:min(420px,calc(100vw - 2rem))}
  .pill-menu.no-sub{width:192px;min-width:192px;max-height:288px}
 /* 通用就地下拉(权限/档位/附件)按内容宽展开,不吃模型菜单的固定 192px */
  .pill-menu.auto-w{width:max-content;min-width:120px;max-width:min(360px,calc(100vw - 2rem))}
  @keyframes pm-pop{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
  .pill-menu{animation:pm-pop .1s ease-out}
  .pill-menu .pm-q{width:100%;box-sizing:border-box;height:28px;background:rgba(255,255,255,.04);
    border:1px solid var(--border-soft);border-radius:6px;color:var(--text);font-family:var(--sans);
    font-size:12.5px;padding:0 8px;margin:0 0 4px;outline:none}
  .pill-menu .pm-q:focus{border-color:var(--bronze)}
 /* 组头=纯文本 13.5px(zcode DropdownMenuLabel)+ 可选文字 badge */
  .pill-menu .pm-head{font-size:13.5px;color:var(--muted);padding:4px 8px 2px;white-space:nowrap}
  .pill-menu .pm-sep{border:0;border-top:1px solid var(--border-soft);margin:4px -4px}
 /* ===== u4 列表项(RadioItem 形态):右侧勾、hover 只用 --menu-hover、选中不加背景 ===== */
  .pill-menu .pm-item{position:relative;display:flex;align-items:center;min-height:32px;border-radius:6px;
    padding:6px 32px 6px 8px;font-family:var(--sans);font-size:13.5px;color:var(--text);cursor:pointer;
    white-space:nowrap;overflow:hidden;outline:none}
  .pill-menu .pm-item:hover,.pill-menu .pm-item.hot{background:var(--menu-hover,rgba(255,255,255,.06));color:var(--text)}
  .pill-menu .pm-main{display:flex;min-width:0;flex:1;align-items:center;gap:6px}
  .pill-menu .pm-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
 /* 勾=绝对定位右侧,仅选中项渲染(不加背景高亮) */
  .pill-menu .pm-ck{position:absolute;right:8px;top:50%;transform:translateY(-50%);
    display:inline-flex;align-items:center;justify-content:center;pointer-events:none;color:var(--faint)}
  .pill-menu .pm-ck .icn{width:14px;height:14px}
  .pill-menu .pm-sub{font-size:11.5px;color:var(--faint);flex-shrink:0}
  .pill-menu .pm-foot{position:sticky;bottom:0;z-index:2;background:var(--window-bg,#141009);
    border-top:1px solid var(--border-soft);padding-top:4px;margin:0 -4px -4px}
  .pill-menu .pm-foot .pm-item{min-height:28px;font-size:12.5px;color:var(--muted);padding-left:10px}
  .pill-menu .pm-foot .pm-item .pm-flip{display:inline-flex;margin-right:4px;color:var(--faint)}
  .pill-menu .pm-grp{display:flex;flex-direction:column;gap:2px}
  .pill-menu .pm-grp.off{display:none}
 /* 模型菜单:provider 两层分组(ZCode ModelConfigSelect 语义)——直展组一级平铺 / 折叠组 hover 子菜单 */
  .pill-menu .pm-ghead{font-size:13.5px;color:var(--muted);white-space:nowrap}
  .pill-menu .pm-ghead.pm-head{padding:4px 8px 2px}
  .pill-menu .pm-badge{font-size:11px;letter-spacing:0;color:var(--faint);background:rgba(255,255,255,.06);
    border-radius:999px;padding:0 5px;flex-shrink:0}
  .pill-menu .pm-badge.plan{color:var(--bronze);background:rgba(201,143,69,.12)}
  .pill-menu .pm-badge.local{color:var(--warn);background:rgba(217,179,108,.12)}
  .pill-menu .pm-chev{margin-left:auto;color:var(--faint);display:inline-flex;align-items:center;flex-shrink:0}
  .pill-menu .pm-chev .icn{width:16px;height:16px}
 /* 折叠组行/返回行里的勾是「行内」语义(zcode SubTrigger:CheckIcon 在文字后、chevron 前),
 所以这两处的 .pm-ck 回到静态流,不参与「右侧绝对定位勾」规则。 */
  .pill-menu .pm-item.pm-ghead .pm-ck,
  .pill-menu .pm-item.pm-back .pm-ck{position:static;transform:none;margin-left:auto;color:var(--faint)}
  .pill-menu .pm-item.pm-ghead .pm-ck + .pm-name{margin-left:0}
  .pill-menu .pm-item.pm-back .pm-ck{order:-1;margin-left:0;margin-right:2px}
  .pill-menu .pm-vis{font-size:11px;color:var(--green);border:1px solid rgba(157,192,139,.4);
    border-radius:999px;padding:0 5px;flex-shrink:0}
  .pill-menu .pm-unv{font-size:11px;color:var(--warn);background:rgba(217,179,108,.12);border-radius:999px;padding:0 5px;flex-shrink:0}
  .pill-menu .pm-foot.sticky{position:sticky;bottom:0;z-index:2;background:var(--window-bg,#141009);padding-top:4px;border-top:1px solid var(--border-soft);margin:0 -4px -4px}
  .pill-menu .pm-warn{display:inline-flex;align-items:center;flex-shrink:0;color:var(--faint)}
  .pill-menu .pm-warn .icn{width:14px;height:14px}
  .pill-menu .pm-item.locked{color:var(--muted);cursor:not-allowed}
  .pill-menu .pm-item.locked:hover{background:transparent;color:var(--muted)}
  .pill-menu .pm-back{color:var(--bronze);margin-bottom:2px}
  .pill-menu .pm-back .pm-flip{transform:rotate(180deg)}
  .pill-menu .pm-lv2 .pm-head{letter-spacing:1px}
  .pill-menu .pm-follow{margin-bottom:0}
  .pill-menu .pm-empty{font-size:12.5px;color:var(--muted);padding:6px 8px}
  .turn-nav{display:flex;gap:6px;margin-left:auto}
  .turn-nav button{background:transparent;border:1px solid var(--border-soft);color:var(--faint);border-radius:6px;font-size:10px;padding:1px 8px;cursor:pointer}
  .turn-nav button:hover{color:var(--bronze)}
 /* F6 白板视图 */
  .wb-tools{margin-left:auto;display:flex;align-items:center;gap:6px}
  .wb-color{width:20px;height:20px;border-radius:6px;border:1px solid var(--border-soft);cursor:pointer;padding:0;flex-shrink:0}
  .wb-color.on{border-color:var(--accent-bright);box-shadow:0 0 0 1px var(--accent-bright)}
  .wb-color[data-c="erase"]{background:transparent;color:var(--muted);font-size:10px;width:auto;min-width:26px;padding:0 7px}
  .wb-color[data-c="erase"]:hover{color:var(--text)}
  #wbWidth{width:90px;accent-color:var(--bronze)}
  .wb-wrap{flex:1;min-height:0;border:1px solid var(--border-soft);border-radius:12px;background:rgba(255,255,255,.03);overflow:hidden;position:relative}
  #wbCanvas{width:100%;height:100%;display:block;cursor:crosshair;touch-action:none}
 /* 语义流程白板 */
  .board-main{flex:1;min-height:420px;display:flex;gap:10px} /* min-height 保底——flex basis 0 的画布区在大板(45 卡清单)下被挤成 padding 条(实测 22px),画布是给人看的主角不能塌 */
 /* 白板 vw-head 窄视口挤压修复:副标单行省略+flex:1 1 0(假设尺寸 0,不把后续项挤下一条
 * flex 线;剩余宽全归副标,紧张时 ellipsis)+按钮成组收纳;「更多」溢出菜单样式全走 088 主题变量 */
  #view-board .vw-sub{flex:1 1 0;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #view-board .vw-acts{margin-left:auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end}
  #view-board .vw-acts .vw-act{margin-left:0}
  #view-board #boardTaskSel{max-width:300px}
  #view-board .vw-more{position:relative;display:none;margin-left:0}
  #view-board .vw-more summary{list-style:none;cursor:pointer}
  #view-board .vw-more summary::-webkit-details-marker{display:none}
  #view-board .vw-more[open] .vw-act{border-color:var(--bronze);color:var(--text)}
  #view-board .vw-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:70;display:flex;flex-direction:column;gap:2px;min-width:136px;
    background:var(--glass2);border:1px solid var(--border-soft);border-radius:10px;padding:6px;box-shadow:0 8px 28px rgba(0,0,0,.45)}
  #view-board .vw-menu-it{font-size:11px;color:var(--muted);border:0;background:transparent;text-align:left;border-radius:7px;padding:6px 10px;cursor:pointer;white-space:nowrap}
  #view-board .vw-menu-it:hover{background:var(--hover-bg);color:var(--text)}
  @media (max-width:1460px){
 /* 中窄档(≤1460:内容区被压到 ~730 以下,8 键全 Inline 必换行):导出两键先收,
 * 「更多」登场;任务选择器让位。>1460 内容区 ≥740,全键单行放得下。 */
    #view-board .vw-acts .vw-act.vw-fold-md{display:none}
    #view-board .vw-menu-it.vw-fold{display:none}
    #view-board .vw-more{display:inline-block}
    #view-board #boardTaskSel{max-width:180px}
  }
  @media (max-width:1024px){
 /* 窄视口:低频五键全收进「更多」,常驻三键(简图/刷新/编辑)内联——头部单行,不再挤压 board-main */
    #view-board .vw-acts .vw-act.vw-fold{display:none}
    #view-board .vw-menu-it.vw-fold{display:flex}
  }
 /* C 窄视口/窄卡片板头余量:视口宽 != 卡片宽(画布外壳的卡片可拖到 320px),所以按
 **自身宽度**裁决(container query),不只看 @media。目标:板头 toolbar 换行/缩小/留 padding,
 不与「白板 Sketch」页标题/板名重叠,画布仍可点。 */
  #view-board{container-type:inline-size}
  @container (max-width:720px){
    #view-board .vw-head{gap:6px 10px;padding-bottom:6px}
    #view-board .vw-title{font-size:17px;letter-spacing:1px}
    #view-board .vw-sub{flex:1 1 100%;white-space:normal;line-height:1.5}
    #view-board .vw-scope{font-size:11px}
    #view-board #boardTaskSel{max-width:140px;min-width:0}
    #view-board .vw-acts{width:100%;gap:4px;justify-content:flex-start}
    #view-board .vw-acts .vw-act{padding:3px 8px;font-size:10px}
  }
 /* 浮窗(可缩到 44vw)头部:按钮换行,板名/进度单行省略,不再横向挤出卡片 */
  .board-float{container-type:inline-size}
  .bf-head{flex-wrap:wrap;row-gap:4px}
  .bf-title{flex-shrink:0}
  .bf-prog{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bf-spacer{flex:1 1 8px;min-width:0}
  @container (max-width:520px){
    .bf-head{padding:6px 8px;gap:4px 6px}
    .bf-title{font-size:11px}
    .bf-head .vw-act{padding:3px 7px;font-size:10px}
    .bf-head .bf-close{font-size:14px}
  }
  .board-graph{flex:1;min-width:0;display:flex;flex-direction:column;overflow:auto;border:1px solid var(--border-soft);border-radius:12px;background:rgba(255,255,255,.03);padding:10px} /* 白板修复:块级父里 .bf-canvas 的 flex:1 无效→恒 340px min-height;flex 列后画布吃满 board-main */
 /* K:宿主已是 flex 列(画布 flex:1 + 底部图例条),不许再让画布 340px 下限把自己顶出
 scrollHeight 之外——否则窄视口下底部图例条要滚动才看得见(实测 418 高宿主 + 85 高图例条 → 滚动 33px)。 */
  .board-graph>.bf-canvas{min-height:220px}
  .board-graph svg{max-width:none}
  .board-detail{width:320px;flex-shrink:0;overflow-y:auto;border:1px solid var(--border-soft);border-radius:12px;padding:12px;background:rgba(255,255,255,.02)}
  .board-nodes-box{margin-top:8px;border:1px solid var(--border-soft);border-radius:10px;padding:4px 10px} /* 白板修复:节点卡清单折叠容器 */
  .board-nodes-box summary{cursor:pointer;font-size:11.5px;color:var(--bronze);user-select:none;list-style:none}
  .board-nodes-box summary::before{content:"▸ ";color:var(--faint)}
  .board-nodes-box[open] summary::before{content:"▾ "}
  .board-nodes{display:flex;flex-wrap:wrap;gap:8px;max-height:260px;overflow-y:auto} /* 白板修复:41 节点清单全展吃掉 ~300px 画布高,展开时也限高滚动; 用户用户反馈「清单太小」150px→260px(约 3 行卡),卡片字号/内边距同步上调一档 */
  .bd-card{border:1px solid var(--border-soft);border-radius:10px;padding:8px 12px;cursor:pointer;max-width:340px;background:rgba(255,255,255,.02)}
  .bd-card:hover{border-color:var(--bronze)}
  .bd-card.on{border-color:var(--accent-bright);box-shadow:0 0 0 1px var(--accent-bright)}
  .bd-name{font-size:13px;color:var(--text);font-weight:600}
  .bd-sum{font-size:12px;color:var(--muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:312px}
  .bd-tag{display:inline-block;font-size:10px;border-radius:4px;padding:0 5px;margin-left:5px;vertical-align:1px}
  .bd-tag.add{background:var(--bcv-chg-add-bg);color:var(--bcv-chg-add-fg)}
  .bd-tag.modify{background:var(--bcv-chg-modify-bg);color:var(--bcv-chg-modify-fg)}
  .bd-tag.delete{background:var(--bcv-chg-delete-bg);color:var(--bcv-chg-delete-fg)}
  .bd-tag.keep{background:var(--bcv-chg-keep-bg);color:var(--bcv-chg-keep-fg)}
  .bd-tag.lk-linked{background:rgba(90,160,106,.14);color:#7ec98f}
  .bd-tag.lk-moved{background:rgba(201,162,94,.16);color:#c9a25e}
  .bd-tag.lk-broken{background:rgba(224,138,122,.2);color:#e08a7a}
 /* 白板可见化(n1):P0 覆盖率徽标——<100% 醒目赭红,100% 全绿 */
  .bd-tag.bd-p0{border:1px solid rgba(224,138,122,.45);color:#e08a7a;background:rgba(224,138,122,.12);font-weight:600}
  .bd-tag.bd-p0.full{border-color:rgba(90,160,106,.5);color:#7ec98f;background:rgba(90,160,106,.16)}
 /* 白板可见化(n2):节点卡/明细卡的验收三态行与证据摘要 */
  .bd-acc-list{margin-top:4px;display:flex;flex-direction:column;gap:3px}
  .bd-acc-row{font-size:11px;color:var(--muted);border-left:2px solid var(--border-soft);padding-left:6px;margin-top:3px} /* 任务3:验收三态行 10px→11px(清单卡字号上调一档,三态可读) */
  .bd-acc-row .bd-acc-st{margin-left:0;font-weight:600}
 /* n10 明细卡「关系」段:出边/入边逐条(目标节点名 + kind 中文名 + 边标签 + 推导徽标) */
  .bd-rel-row{display:flex;align-items:baseline;gap:5px;font-size:10px;color:var(--muted);margin-top:2px;border-left:2px solid var(--border-soft);padding-left:6px}
  .bd-rel-row .bd-rel-arrow{color:var(--bronze-dim)}
  .bd-rel-row .bd-rel-t{color:var(--text);overflow-wrap:anywhere}
  .bd-rel-row .bd-rel-k{font-size:11px;color:var(--bronze)}
  .bd-rel-row .bd-rel-l{font-size:11px;color:var(--faint);overflow-wrap:anywhere}
  .bd-rel-row .bd-rel-v{margin-left:0;font-size:11px}
  .bd-acc-cmd{font-family:var(--mono);font-size:10px;color:var(--text);overflow-wrap:anywhere}
  .bd-acc-exp{color:var(--bronze);font-size:11px;overflow-wrap:anywhere}
  .bd-acc-note{color:var(--faint);font-size:11px}
  .bd-acc-out{font-family:var(--mono);font-size:11px;color:var(--muted);overflow-wrap:anywhere}
  .bd-ev summary{cursor:pointer;font-size:11px;color:var(--bronze);list-style:none}
  .bd-ev summary::before{content:"▸ "}
  .bd-ev[open] summary::before{content:"▾ "}
  .bd-ev-full{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:pre-wrap;max-height:180px;overflow-y:auto;border:1px solid var(--border-soft);border-radius:6px;padding:4px 6px;margin-top:2px;background:rgba(0,0,0,.25)}
 /* 白板可见化(A3):节点卡清单泳道分组(复用画布泳道观感:编号+标题+左侧色条) */
  .bd-grp{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start;border-left:2px solid var(--border-soft);padding-left:6px;margin-bottom:6px;width:100%}
  .bd-grp-h{width:100%;font-size:10px;color:var(--bronze);font-family:var(--mono);letter-spacing:.4px}
  .bd-grp-h b{display:inline-block;background:var(--bronze-dim);color:#0b1118;border-radius:4px;padding:0 4px;margin-right:5px;font-weight:700}
  .bd-no{font-family:var(--mono);font-size:11px;color:var(--faint);margin-right:4px}
  .cv-acc{font-size:11px;flex-shrink:0}
  .bd-flow{margin:8px 0 0 0;padding-left:0;list-style:none;font-size:11px;color:var(--text)}
  .bd-flow li{margin:3px 0;line-height:1.5}
  .bd-flow .fl-cond{color:var(--bronze)}
  .bd-flow .fl-sub{padding-left:14px;border-left:1px solid var(--border-soft);margin-left:5px}
 /* 节点勾选派发(纯 UI 态,不落盘):卡头复选框 + 工具条「已选 N 个 / 派发选中」 */
  .bd-sel{margin:0 5px 0 0;vertical-align:-1px;accent-color:var(--bronze);cursor:pointer}
  .bd-sel-bar{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}
  .bd-sel-bar #bdSelCount{font-family:var(--mono);color:var(--bronze)}
  .bd-sel-bar .vw-act[disabled]{opacity:.4;cursor:not-allowed}
 /* 语义流程摘要(折叠态可见):一行「分支 N / 循环 M」,点开复用 bdFlowHtml 递归块 */
  .bd-flowsum{margin-top:3px}
  .bd-flowsum summary{cursor:pointer;font-size:10px;color:var(--bronze);list-style:none}
  .bd-flowsum summary::before{content:"▸ "}
  .bd-flowsum[open] summary::before{content:"▾ "}
  .bd-flowsum .bd-flow{margin-top:4px;font-size:10.5px}
  .bd-meta{font-size:11px;color:var(--muted);margin-top:6px}
  .board-sketch{margin-top:10px;border:1px solid var(--border-soft);border-radius:12px;padding:8px 10px}
  .board-sketch summary{cursor:pointer;color:var(--muted);font-size:12px}
  .board-sketch[open] summary{margin-bottom:6px}
  .board-sketch .wb-wrap{height:320px;flex:none}
  .board-chip{background:transparent;border:1px solid var(--bronze);color:var(--bronze);border-radius:6px;font-size:var(--fs-chip);padding:1px 8px;cursor:pointer;margin-left:8px}
  .board-chip:hover{color:var(--accent-bright);border-color:var(--accent-bright)}
 /* 实时白板浮窗(五期; 升级为大覆盖层:入口统一后浮窗=主入口,
 布局=左板清单 + 中 Dify 画布 + 右抽屉节点明细/评论;与大白板视图同一板状态的两个视口) */
  .board-float{position:fixed;right:24px;bottom:120px;width:520px;max-width:44vw;z-index:58;display:flex;flex-direction:column;
    background:rgba(18,13,8,.97);border:1px solid var(--bronze);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.6)}
  .board-float.bf-big{width:min(1150px,92vw);height:min(780px,88vh);max-width:none;bottom:48px}
  .bf-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border-soft);cursor:move;user-select:none}
  .bf-title{font-size:12px;color:var(--bronze);font-weight:700}
  .bf-prog{font-size:11px;color:#b9a887} /* :浮窗恒深底,文字固定浅色(light/ink 下按钮/进度灰字 2.7:1 不足) */
  .bf-close{background:none;border:none;color:#9a8c72;font-size:15px;cursor:pointer;padding:0 4px}
  .board-float .vw-act{color:#d8c9a8;border-color:#8a7a5a} /* 浮窗内操作按钮同根因(全局 vw-act 走主题变量,深底上洗白) */
  .board-float .vw-act:hover{color:#eee2c6}
  .bf-close:hover{color:var(--text)}
  .bf-done{color:#7ec98f;font-weight:700}
  .bf-pending{color:var(--faint)}
  .bf-comments{margin-top:6px;padding-left:10px;border-left:2px solid var(--bronze-soft,#8a7a5a)}
  .bf-cmt{font-size:11px;color:var(--text);margin:2px 0}
  .bf-cmt-input{display:flex;gap:6px;margin-top:6px}
  .bf-cmt-input input{flex:1;background:rgba(255,255,255,.04);border:1px solid var(--border-soft);color:var(--text);border-radius:8px;padding:4px 8px;font-size:11px}
 /* c1 单条评论编辑/删除:文本 + 右侧「改」「删」小按钮(克制成 10.5px,悬停才提亮) */
  .bf-cmt-row{display:flex;gap:6px;align-items:flex-start;margin:2px 0}
  .bf-cmt-row .bf-cmt{flex:1;margin:0}
  .bf-cmt-acts{display:flex;gap:3px;flex-shrink:0}
  .bf-cmt-acts button{background:none;border:1px solid var(--border-soft);border-radius:6px;color:var(--faint);cursor:pointer;font-size:10px;line-height:1;padding:2px 5px}
  .bf-cmt-acts button:hover{color:var(--text);border-color:var(--bronze-dim)}
  .bf-cmt-edit{display:flex;gap:4px;align-items:center;margin:2px 0}
  .bf-cmt-edit input{flex:1;background:rgba(255,255,255,.04);border:1px solid var(--bronze-dim);color:var(--text);border-radius:8px;padding:3px 7px;font-size:11px}
  .cv-ncmt .bf-cmt-row{margin:1px 0}
  .cv-ncmt .bf-cmt-acts button{font-size:11px;padding:1px 4px}
 /* n1 画布白板卡一级操作条 + n2 评论模式/节点内联评论框 */
 /* 操作条贴在卡头右侧(与 .cv-card-tools 成组):抢在 tools 的 margin-left:auto 之前吃掉余量 */
  .cv-card-acts{margin-left:auto;display:flex;gap:4px;align-items:center;flex-shrink:0}
  .cv-card-acts + .cv-card-tools{margin-left:4px}
  .cv-card-acts .vw-act{font-size:10.5px;padding:2px 7px;border-radius:7px;border-color:var(--border-soft);color:var(--muted);background:rgba(255,255,255,.03);cursor:pointer}
  .cv-card-acts .vw-act:hover{color:var(--accent-bright);border-color:var(--bronze);background:rgba(201,143,69,.14)}
  .cv-card-acts .vw-act.on{color:var(--accent-bright);border-color:var(--bronze);background:rgba(201,143,69,.22)}
  body.cv-lod .cv-card-acts{display:none} /* 离屏/LOD 折叠态卡头只留标题,操作条不占位 */
  .cv-node.cmt-on{border-color:var(--bronze);outline:1px dashed rgba(201,143,69,.55);outline-offset:2px}
  .cv-node.cmt-on .cv-cmts{display:inline-block!important} /* 评论模式:0 条也露出徽标(它就是入口) */
 /* n12 待读评论:该节点有用户评论、agent 还没读(board.list.result 的 pendingComments 落到节点级) */
  .cv-node.cmt-pending{border-color:var(--bronze);box-shadow:0 0 0 1px var(--bronze),0 6px 18px rgba(0,0,0,.45)}
  .cv-node.cmt-pending .cv-cmts{display:inline-block!important}
  .cv-ncmt{position:absolute;left:6px;right:6px;bottom:6px;z-index:9;background:var(--bcv-float-bg-solid);
    border:1px solid var(--bronze);border-radius:9px;padding:6px 7px;box-shadow:0 8px 24px rgba(0,0,0,.6);cursor:default}
  .cv-ncmt-h{font-size:10.5px;color:var(--bronze);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-ncmt .bd-meta{font-size:10px}
  .cv-ncmt .bf-cmt{font-size:10.5px}
  .cv-ncmt .bf-cmt-input{margin-top:4px}
  .cv-ncmt .bf-cmt-input input{font-size:10.5px;padding:3px 6px}
  .cv-ncmt .vw-act{font-size:10px;padding:2px 6px}
  .bf-main{display:flex;flex:1;min-height:0}
  .bf-list{width:188px;flex:none;overflow-y:auto;border-right:1px solid var(--border-soft);padding:8px}
  .bf-item{border:1px solid var(--border-soft);border-radius:9px;padding:7px 9px;margin-top:6px;cursor:pointer;background:rgba(255,255,255,.02)}
  .bf-item:hover{border-color:var(--bronze)}
  .bf-item.on{border-color:var(--accent-bright);box-shadow:0 0 0 1px var(--accent-bright)}
  .bf-item-t{font-size:11px;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bf-item-m{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--faint);margin-top:3px}
  .bf-item-m .bd-tag{margin-left:0}
 /* n14 多板搜索/过滤:搜索框 + 类型下拉(常驻清单顶部,状态在模块级,重渲不清空) */
  .bf-search{display:flex;gap:4px;margin-bottom:2px}
  .bf-search input{flex:1;min-width:0;background:var(--input-bg);border:1px solid var(--input-border);color:var(--text);border-radius:7px;padding:3px 7px;font-size:10.5px;outline:none}
  .bf-search input:focus{border-color:var(--bronze)}
  .bf-search select{flex:none;background:var(--input-bg);border:1px solid var(--input-border);color:var(--muted);border-radius:7px;padding:3px 4px;font-size:10.5px;outline:none}
  .bf-graph{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;padding:8px}
  .bf-graph svg{max-width:none}
  .bf-graph .bf-canvas{flex:1;min-height:0}
  .bf-graph .cc-empty{margin:auto}
  .bf-detail{width:300px;flex:none;overflow-y:auto;border-left:1px solid var(--border-soft);padding:10px;background:rgba(255,255,255,.02)}
 /* 白板修复:明细抽屉空态(未选节点)不占画布宽度——浮窗画布 644→944、大白板画布满宽;
 :has 不支持的老浏览器忽略本条=保持常驻(优雅降级),选中节点即恢复占位 */
  #boardDetail:has(> .cc-empty), .bf-detail:has(> .cc-empty){display:none}
  .bf-editbar{display:flex;align-items:center;gap:6px;margin-top:10px;padding-top:8px;border-top:1px dashed var(--border-soft);font-size:10px;color:var(--bronze)}
  .bf-editbar span{flex:1}
 /* 六期:工作流画布(零依赖手写) */
  .bf-canvas{position:relative;flex:1;min-height:340px;overflow:hidden;border:1px solid var(--border-soft);border-radius:12px;background:
    radial-gradient(circle at 1px 1px, var(--bcv-grid-dot) 1px, transparent 1.4px) 0 0/22px 22px, var(--bcv-canvas-bg);cursor:grab}
  .bf-canvas.panning{cursor:grabbing}
  .bf-canvas.marqueeing{cursor:crosshair}
  .bf-cv-world{position:absolute;left:0;top:0;transform-origin:0 0}
 /* 九期:画布交互全集——框选/多选/小地图/缩放控件/对齐辅助线 */
  .bf-marquee{position:absolute;border:1px solid var(--bronze);background:rgba(201,143,69,.10);pointer-events:none;z-index:6}
  .cv-node.selected{border-color:var(--accent-bright);box-shadow:0 0 0 2px rgba(236,225,209,.35),0 6px 18px rgba(0,0,0,.45)}
 /* svg 模式选中态:flowkit 出的 <g data-node-id> 就地加 .cv-svg-on(详情卡选中的视觉回声) */
  #cvSvgHost [data-node-id].cv-svg-on rect, #cvSvgHost [data-node-id].cv-svg-on path, #cvSvgHost [data-node-id].cv-svg-on ellipse, #cvSvgHost [data-node-id].cv-svg-on polygon { stroke: var(--bronze, #c98b52) !important; stroke-width: 2.5 !important; }
  .cv-helpline{position:absolute;background:var(--accent-bright);opacity:.65;pointer-events:none;z-index:7}
  .cv-helpline.v{width:1px}.cv-helpline.hh{height:1px}
  .bf-zoombar{position:absolute;right:10px;bottom:10px;display:flex;flex-direction:column;gap:4px;z-index:8;
    background:var(--bcv-float-bg);border:1px solid var(--border-soft);border-radius:10px;padding:4px}
  .bf-zoombar button{background:none;border:none;color:var(--muted);font-size:12px;cursor:pointer;padding:3px 8px;border-radius:6px}
  .bf-zoombar button:hover{color:var(--bronze);background:rgba(255,255,255,.05)}
  .bf-zoombar .bf-zpct{font-size:10px;color:var(--muted);text-align:center;padding:1px 0;min-width:38px}
 /* fixD4(v2): 小地图保持可点(z8/auto 不变——直接点击兼容既有用法/回归),但两处让位:
 ①背景降透明(.92→.62)盖不住下层节点;②点按位置正下方有节点卡=转派 pointerdown 给节点(见 ensureCvDelegation),
 不再劫持该点拖拽/不再跳视口。无节点处点按=原跳转行为。 */
 /* 画布态新卡头部压缩:卡 chrome 已有标题/副标,卡内 vw-sub 冗余 */
  body.cv-shell #view-track .vw-sub, body.cv-shell #view-usage .vw-sub{display:none}
  .cv-node[data-cv^="ph-"]{padding:3px 8px;overflow:hidden}
  .cv-node[data-cv^="ph-"] .cv-nsub,.cv-node[data-cv^="ph-"] .cv-nfoot{display:none}
  .cv-node[data-cv^="ph-"] .cv-nhead{font-size:11.5px}
  .kb-line{border:1px solid var(--border);border-radius:8px;padding:5px 10px}
  .kb-dot{display:inline-block;min-width:8px;height:8px;border-radius:50%}
  body.cv-shell #view-track .vw-head, body.cv-shell #view-usage .vw-head{padding:4px 8px}
 /* 白板小地图默认收起为角标,hover 展开(不再压住流程泳道首节点/元信息条) */
  .bf-minimap{width:44px;height:26px;transition:width .18s,height .18s}
  .bf-minimap:hover,.bf-minimap:focus-visible{width:148px;height:96px}
  .bf-minimap{position:absolute;left:10px;bottom:10px;z-index:8;
    background:var(--bcv-float-bg-dim);border:1px solid var(--border-soft);border-radius:10px;overflow:hidden;cursor:pointer}
  .bf-minimap canvas{width:100%;height:100%;display:block}
  .bf-cv-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
  .bf-cv-edges path{fill:none;stroke:var(--bcv-edge-line);stroke-width:2}
  .bf-cv-edges path.bfe-call{stroke:var(--bcv-edge-call)}
  .bf-cv-edges path.bfe-data{stroke:var(--bcv-edge-data);stroke-dasharray:5 3}
  .bf-cv-edges path.bfe-verify{stroke:var(--bcv-edge-verify);stroke-dasharray:2 3}
 /* 页面结构板:nav=页面间导航(实线箭头)/contains=包含(无线头,浅色实线) */
  .bf-cv-edges path.bfe-nav{stroke:var(--bcv-edge-line);stroke-width:1.8} /* 白板修复:普通 nav 弃金(#c9a25e≈主线金)→青铜,主线亮金唯一 */
  .bf-cv-edges path.bfe-contains{stroke:var(--bcv-edge-contains);stroke-width:1.4}
  .bf-cv-edges path.bfe-virtual{stroke:var(--bcv-edge-line);stroke-dasharray:2 5;stroke-width:1.2}
  .bf-cv-edge-label{font-size:11px;fill:var(--bcv-edge-label);paint-order:stroke;stroke:var(--bcv-edge-label-halo);stroke-width:3px;stroke-linejoin:round} /* 白板修复:标签深色底衬(halo),压在线条/深底上可读 */
 /* 边标签常显:隐藏门槛由 cvLabelHideK 单一出处给出(默认 40%,UI 交互图 38%)——
 「适」(k≈0.9)与常规阅读距离下标签一律可见,只有真缩到看不清时才让位。 */
  .bf-cv-world.z-low .bf-cv-edge-label{display:none}
 /* C(经验证:svg 模式下缩到 k=0.3,3 条 flowkit 边标签仍全可见 = z-low 名存实亡):
 flowkit 出的边标签是 g[data-connector-id] 里的 rect(底衬)+text(关系词),没有 .bf-cv-edge-label 类,
 上一条规则匹配不到。这里按 connector 组兜住:只隐 rect(底衬)+text(关系词),path(线/箭头)照常可见。 */
  .bf-cv-world.z-low [data-connector-id] rect,.bf-cv-world.z-low [data-connector-id] text{display:none}
 /* 出图等待期保留上一版 svg(data-stale="1"):轻微降透明度提示「还在算新图」,绝不把画布清空 */
  .cv-svg-host[data-stale="1"]{opacity:.45;transition:opacity .18s ease}
 /* svg 连线态:光标 crosshair + 顶部提示条 + 极小关系词输入框 */
  .bf-canvas.cv-linking,#cvHost.cv-linking,#cvHost.cv-linking #cvSvgHost{cursor:crosshair}
  .cv-link-hint{position:absolute;left:50%;top:8px;transform:translateX(-50%);z-index:12;pointer-events:none;
    background:var(--bcv-thead-bg);border:1px solid var(--bcv-thead-bd);border-radius:999px;padding:4px 12px;
    font-size:12px;color:var(--bcv-thead-fg);box-shadow:var(--bcv-thead-shadow);white-space:nowrap}
  .cv-link-word{position:absolute;left:50%;top:44px;transform:translateX(-50%);z-index:13;display:flex;align-items:center;gap:6px;
    background:rgba(18,13,8,.97);border:1px solid var(--border-soft);border-radius:10px;padding:6px 8px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
  .cv-link-word span{font-size:11px;color:var(--faint)}
  .cv-link-word input{width:104px;background:rgba(255,255,255,.04);border:1px solid var(--border-soft);color:var(--text);
    border-radius:7px;padding:3px 7px;font-size:12px}
  .cv-link-word button{background:none;border:1px solid var(--border-soft);color:var(--text);border-radius:7px;
    padding:3px 9px;font-size:11px;cursor:pointer}
 /* 工具箱推荐项:按板型置顶 + 「推荐」小徽标(code 板=函数/模块/决策) */
  .cv-addpanel .cv-aitem .cv-reco{margin-left:auto;font-size:10px;line-height:14px;padding:0 5px;border-radius:5px;
    color:#e6cfa0;border:1px solid rgba(201,162,94,.5);background:rgba(201,162,94,.12)}
  .cv-addpanel .cv-aitem.cv-reco-on{background:rgba(201,143,69,.1)}
  .cv-node{position:absolute;width:216px;background:var(--bcv-card-bg);border:1px solid var(--bcv-card-bd);border-radius:12px;
    padding:0 0 8px;cursor:pointer;box-shadow:0 6px 18px var(--bcv-card-shadow);user-select:none;
 /* 主题跟随:卡主体色改走主题变量(--solid 不透明面板色/--border 结构边/--text/--muted),
 七套主题与 light 自动继承;卡内三层字色做成局部变量,深底线框变体(k-page/k-section/component/nav)
 在自己的规则里回填原浅色(它们只换底色,不跟浅色主题)——默认值=鎏金夜现状,视觉零漂移 */
    --cv-head-fg:var(--bcv-title-fg);--cv-sub-fg:var(--bcv-sum-fg);--cv-foot-fg:var(--bcv-foot-fg)}
 /* 页面结构板线框形态:page=浏览器窗线框/section=虚线区框/component=轻量件/nav=导航条
 (这四类是「线框窗口/分区框」而不是普通节点卡——底色本就是深色线框语义,保留;
 字色因此回填固定浅色,不吃浅色主题的深字) */
  .cv-node.k-page{border-color:var(--bcv-wire-page-bd);background:var(--bcv-wire-page-bg);--cv-head-fg:var(--bcv-wire-title-fg);--cv-sub-fg:var(--bcv-wire-sum-fg);--cv-foot-fg:var(--bcv-wire-foot-fg)}
  .cv-node.k-page .cv-head{background:var(--bcv-wire-page-head);border-radius:11px 11px 0 0;border-bottom:1px solid var(--bcv-wire-page-head-bd);padding:6px 10px}
  .cv-node.k-page .cv-head::before{content:"";flex-shrink:0;width:7px;height:7px;border-radius:50%;background:#e08a7a;box-shadow:11px 0 0 #c9a25e,22px 0 0 #5aa06a;margin-right:30px}
  .cv-node.k-section{border-style:dashed;border-color:var(--bcv-wire-section-bd);background:var(--bcv-wire-section-bg);--cv-head-fg:var(--bcv-wire-title-fg);--cv-sub-fg:var(--bcv-wire-sum-fg);--cv-foot-fg:var(--bcv-wire-foot-fg)}
  .cv-node.k-component{border-color:var(--bcv-wire-component-bd);background:var(--bcv-wire-component-bg);--cv-head-fg:var(--bcv-wire-title-fg);--cv-sub-fg:var(--bcv-wire-sum-fg);--cv-foot-fg:var(--bcv-wire-foot-fg)}
  .cv-node.k-nav{border-color:var(--bcv-wire-nav-bd);background:var(--bcv-wire-nav-bg);--cv-head-fg:var(--bcv-wire-title-fg);--cv-sub-fg:var(--bcv-wire-sum-fg);--cv-foot-fg:var(--bcv-wire-foot-fg)}
 /* ---- 页面结构板语义布局:page=浏览器窗容器(三点头+地址条+分区底色+主线金框);
 section/component=容器内 UI 线框(role 类:顶栏横条/侧栏/主区/底栏/浮层/未归属);
 主线边粗金、回边虚线灰;图例左下 ---- */
  .cv-node.pgbox{width:216px;border-radius:12px;box-shadow:0 4px 16px var(--bcv-card-shadow)}
  .cv-node.pgbox.pgmain{border-width:2.5px;box-shadow:0 0 0 1px var(--bcv-pgmain-ring),0 0 14px var(--bcv-pgmain-glow),0 6px 22px var(--bcv-card-shadow)}
  .cv-node.pgbox .cv-pgbar{display:flex;align-items:center;gap:8px;padding:8px 10px 0}
  .cv-node.pgbox .cv-dots{display:flex;gap:4px;flex-shrink:0}
  .cv-node.pgbox .cv-dots i{width:6px;height:6px;border-radius:50%;background:var(--bcv-dot-idle)}
  .cv-node.pgbox .cv-dots i:first-child{background:var(--bcv-dot-bad)}
  .cv-node.pgbox .cv-dots i:nth-child(2){background:var(--bcv-dot-warn)}
  .cv-node.pgbox .cv-dots i:nth-child(3){background:var(--bcv-dot-ok)}
  .cv-node.pgbox .cv-url{flex:1;min-width:0;font-size:11px;color:var(--bcv-wire-foot-fg);background:var(--bcv-wire-url-bg);border-radius:6px;padding:2px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--mono)} /* :节点卡底恒为深色内联,文字弃主题变量固定浅色——light/ink 下 var(--faint) 深字压深底 1.0x:1 近隐形 */
  .cv-node.pgbox .cv-pgmain-tag{font-size:11px;color:var(--bcv-on-accent);background:var(--bcv-accent);border-radius:4px;padding:1.5px 6px;font-weight:700;flex-shrink:0}
  .cv-node.pgbox .cv-pgtitle{font-size:13px;font-weight:700;color:#eee2c6;padding:5px 12px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} /* :固定浅色(同上,light/ink 1.0-1.3:1 近隐形根治) */
  .cv-wire{background:var(--bcv-wire-bg);border:1px solid;border-radius:6px;overflow:hidden;display:flex;align-items:center;gap:6px;padding:0 8px}
 /* docs 两层 PPT:结论根横幅 / 章容器卡 / 章内页卡 */
  .cv-doc-root{background:linear-gradient(135deg,var(--bcv-doc-root-bg1),var(--bcv-doc-root-bg2));border:2px solid var(--bcv-doc-root-bd);border-radius:10px;box-shadow:0 6px 18px var(--bcv-doc-shadow);padding:10px 14px;overflow:hidden}
  .cv-doc-root-tag{display:inline-block;font-size:11px;font-weight:700;color:var(--bcv-doc-root-tag-fg);background:var(--bcv-doc-root-tag-bg);border-radius:4px;padding:1px 6px;letter-spacing:1px}
  .cv-doc-root-title{font-size:14px;font-weight:800;color:var(--bcv-doc-root-title);line-height:1.35;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .cv-doc-root-sum{font-size:11px;color:var(--bcv-doc-root-sum);margin-top:3px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .cv-doc-chapter{border:1.5px solid;border-radius:9px;overflow:hidden;padding:8px 10px;box-shadow:0 4px 12px var(--bcv-doc-shadow)}
  .cv-doc-ch-h{display:flex;align-items:baseline;gap:6px;font-size:12px;font-weight:700;color:var(--bcv-doc-ch-h);white-space:nowrap;overflow:hidden}
  .cv-doc-ch-h b{font-family:var(--mono);font-size:11px;color:var(--bcv-doc-ch-hb-fg);background:var(--bcv-doc-ch-hb-bg);border-radius:4px;padding:1px 5px;flex-shrink:0}
  .cv-doc-ch-h span{overflow:hidden;text-overflow:ellipsis}
  .cv-doc-ch-n{font-style:normal;font-size:11px;color:var(--bcv-doc-ch-n);margin-left:auto;flex-shrink:0}
  .cv-doc-ch-sum{font-size:11px;color:var(--bcv-doc-ch-sum);margin-top:4px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .cv-doc-page{background:var(--bcv-doc-page-bg);border:1px solid var(--bcv-doc-page-bd);border-radius:7px;padding:7px 9px;overflow:hidden;box-shadow:0 3px 8px var(--bcv-doc-shadow-soft)}
  .cv-doc-pg-h{font-size:10.5px;font-weight:700;color:var(--bcv-doc-pg-h);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-doc-pg-h b{font-family:var(--mono);font-size:11px;color:var(--bcv-doc-pg-hb);border:1px solid var(--bcv-doc-pg-hb-bd);border-radius:3px;padding:0 3px;margin-right:4px}
  .cv-doc-pg-sum{font-size:11px;color:var(--bcv-doc-pg-sum);margin-top:3px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
  .cv-wire .cv-wire-tt{position:absolute;left:0;top:0;bottom:0;width:3px}
  .cv-wire .cv-wire-label{font-size:11px;color:#e6d9bf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;line-height:1.3;position:relative} /* :线框卡标签固定浅色(卡底深色内联,同 pgtitle 根因) */
  .cv-wire .cv-dot{flex-shrink:0}
  .cv-wire.rw-top{border-radius:4px}
  .cv-wire.rw-overlay{border-style:dashed;background:rgba(30,20,12,.86);box-shadow:0 6px 14px rgba(0,0,0,.45);z-index:3}
  .cv-wire.rw-orphan{border-style:dotted;opacity:.8}
  .cv-wire.on{box-shadow:0 0 0 1px var(--accent-bright)}
  .cv-wire.selected{border-color:var(--accent-bright)}
 /* ---- UI 交互流程板:多屏原型地图(屏幕卡/元素行/触点/流线/图例) ----
 形态来源=用户给的线稿交互流程:多屏并排 + 元素级跳转 + 彩色流线图例 + 主线屏。
 不是把页面结构图缩小,而是「屏幕地图」:屏卡在底层(z1),区块(z2)/元素行(z3)浮在屏上,
 字幕带(z4)在屏上方,顶部摘要/图例(z6)固定在世界顶部(导出 PNG 同图)。 */
  .cv-node.cv-ui-screen{padding:0;display:block;overflow:visible;z-index:1;border-radius:18px;
    background:linear-gradient(180deg,#1a1510 0%,#0f0c09 100%);
    border:1.5px solid rgba(214,194,158,.24);box-shadow:0 16px 40px rgba(0,0,0,.46)}
  .cv-node.cv-ui-screen.ui-main{border-color:rgba(224,180,106,.72);box-shadow:0 0 0 1px rgba(224,180,106,.22),0 16px 40px rgba(0,0,0,.5)}
  .cv-ui-chrome{position:absolute;left:0;top:0;right:0;height:34px;border-bottom:1px solid rgba(214,194,158,.14);
    background:rgba(255,255,255,.025);border-radius:17px 17px 0 0;overflow:hidden;z-index:1}
  .cv-ui-screen .bd-tag.cv-cmts{position:absolute;right:8px;top:8px;font-size:11px;z-index:2}
  .cv-ui-status{display:flex;align-items:center;justify-content:space-between;height:16px;padding:1px 10px 0;font-size:11px;color:#a89a7d;letter-spacing:.2px}
  .cv-ui-status-r{font-size:11px;letter-spacing:1px;color:#8f8068}
  .cv-ui-nav{display:flex;align-items:center;gap:5px;height:21px;padding:0 9px;color:#eee2c6;font-size:11px}
  .cv-ui-nav .cv-ui-back{font-size:15px;line-height:1;color:#c9b99a;margin-top:-2px}
  .cv-ui-nav .cv-ui-navtt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:10.5px}
  .cv-ui-nav .cv-ui-more{color:#a89a7d;font-size:11px}
  .cv-ui-browser{display:flex;align-items:center;gap:7px;height:34px;padding:0 10px}
  .cv-ui-browser .cv-ui-dots{display:flex;gap:3px;flex-shrink:0}
  .cv-ui-browser .cv-ui-dots i{width:5px;height:5px;border-radius:50%;background:#7a6a4e}
  .cv-ui-browser .cv-ui-dots i:first-child{background:#e08a7a}
  .cv-ui-browser .cv-ui-dots i:nth-child(2){background:#d9b36c}
  .cv-ui-browser .cv-ui-dots i:nth-child(3){background:#9dc08b}
  .cv-ui-browser .cv-ui-url{flex:1;min-width:0;font-size:11px;color:#a89a7d;background:rgba(0,0,0,.35);border-radius:5px;padding:2px 7px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--mono)}
  .cv-ui-dtabs{display:flex;align-items:center;gap:2px;max-width:46%;overflow:hidden;flex-shrink:0}
  .cv-ui-dtab{font-size:11px;color:#8f8068;padding:1px 6px;border-radius:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:64px}
  .cv-ui-dtab.on{color:#1c1108;background:#e0b46a;font-weight:700}
  .cv-ui-empty{position:absolute;left:14px;right:14px;top:54%;transform:translateY(-50%);padding:10px 8px;border:1px dashed rgba(214,194,158,.2);
    border-radius:8px;text-align:center;font-size:11px;color:#8f8068;background:rgba(255,255,255,.02)}
 /* 设备布局区域:网页 header/sidebar/toolbar/footer/dialog;桌面同源;移动端 content/actionbar/tabbar */
  .cv-ui-logo{position:absolute;left:7px;top:5px;font-size:11px;color:#e0b46a}
  .cv-ui-rail{position:absolute;left:0;top:4px;bottom:4px;width:2px;border-radius:2px;background:rgba(111,168,255,.55)}
  .cv-node.cv-ui-sec.sec-header{background:linear-gradient(90deg,rgba(224,180,106,.12),rgba(255,255,255,.02));border-color:rgba(224,180,106,.32);
    border-radius:6px;padding-left:24px;box-shadow:none}
  .cv-node.cv-ui-sec.sec-sidebar{background:rgba(111,168,255,.055);border-color:rgba(111,168,255,.22);padding-left:10px;box-shadow:none}
  .cv-node.cv-ui-sec.sec-toolbar{background:rgba(255,255,255,.045);border-color:rgba(214,194,158,.22);border-radius:6px;padding:3px 6px;box-shadow:none}
  .cv-node.cv-ui-sec.sec-footer{background:rgba(255,255,255,.028);border-color:rgba(214,194,158,.2);border-radius:5px;box-shadow:none}
  .cv-node.cv-ui-sec.sec-dialog{background:rgba(26,20,14,.97);border:1px solid rgba(201,162,94,.5);border-radius:10px;
    box-shadow:0 14px 34px rgba(0,0,0,.6);z-index:5}
  .cv-node.cv-ui-sec.sec-form{background:rgba(255,255,255,.035);border-color:rgba(111,168,255,.22)}
  .cv-node.cv-ui-sec.sec-list{background:rgba(255,255,255,.028);border-color:rgba(214,194,158,.2)}
  .cv-ui-actionbar{position:absolute;z-index:2;background:rgba(8,6,4,.58);border-top:1px solid rgba(214,194,158,.18);
    border-radius:10px;pointer-events:none;box-shadow:0 -4px 14px rgba(0,0,0,.25)}
 /* 浮层(弹窗/底部抽屉/右侧抽屉/下拉):页内遮罩 + 独立窗口本体;触发按钮保持在遮罩之上可见。 */
  .cv-ui-popmask{position:absolute;z-index:4;background:rgba(8,6,4,.42);border-radius:14px;pointer-events:none;
    box-shadow:inset 0 0 40px rgba(0,0,0,.35)}
  .cv-node.cv-ui-sec.cv-ui-popup,.cv-node.cv-ui-pop-card{position:absolute;z-index:6;display:block;padding:0;overflow:hidden;
    background:rgba(26,20,14,.985);border:1px solid rgba(224,180,106,.78);border-radius:12px;
    box-shadow:0 20px 54px rgba(0,0,0,.66),0 0 0 1px rgba(224,180,106,.14)}
  .cv-ui-pop-head{display:flex;align-items:center;gap:5px;height:26px;padding:0 8px;
    background:linear-gradient(90deg,rgba(224,180,106,.14),rgba(224,180,106,.04));border-bottom:1px solid rgba(214,194,158,.18)}
  .cv-ui-pop-tt{flex:1;min-width:0;font-size:11px;font-weight:800;color:#f0e3c8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-ui-pop-kind{flex-shrink:0;font-size:11px;color:#1c1108;background:#e0b46a;border-radius:4px;padding:0 4px;font-weight:700}
  .cv-ui-pop-close{flex-shrink:0;width:14px;height:14px;line-height:13px;text-align:center;border-radius:4px;color:#a89a7d;
    background:rgba(255,255,255,.05);font-size:12px}
  .cv-ui-pop-body{padding:6px 8px;font-size:11px;color:#b9ab90;line-height:1.35;overflow:hidden}
  .cv-node.cv-ui-pop-child{position:absolute;z-index:7}
  .cv-node.cv-ui-pop-trigger{z-index:5}
  .cv-node.cv-ui-pop-child.cv-ui-pop-trigger{z-index:8}
  .cv-node.cv-ui-sec.cv-ui-pop-heading{z-index:7;background:transparent;border-color:transparent;box-shadow:none;
    padding:2px 2px 0;height:14px;overflow:hidden}
  .cv-node.cv-ui-sec.cv-ui-pop-heading .cv-ui-sec-h{font-size:11px;font-weight:700;color:#c9a25e;letter-spacing:.4px}
  .cv-node.cv-ui-row.ctl-primary{background:#e0b46a;border-color:#e0b46a;justify-content:center;padding:0 8px;
    box-shadow:0 2px 8px rgba(224,180,106,.28)}
  .cv-node.cv-ui-row.ctl-primary .cv-ui-row-lb{color:#1c1108;font-weight:800;text-align:center;flex:0 1 auto}
  .cv-node.cv-ui-row.ctl-secondary{background:transparent;border-color:rgba(224,180,106,.58);justify-content:center}
  .cv-node.cv-ui-row.ctl-secondary .cv-ui-row-lb{color:#e6d9bf;text-align:center;flex:0 1 auto}
  .cv-node.cv-ui-row.ctl-danger{background:rgba(242,124,141,.12);border-color:rgba(242,124,141,.6);justify-content:center}
  .cv-node.cv-ui-row.ctl-danger .cv-ui-row-lb{color:#f7b6c0;text-align:center}
  .cv-node.cv-ui-row.ctl-text{background:transparent;border-color:transparent;justify-content:flex-start;padding:0 2px;box-shadow:none}
  .cv-node.cv-ui-row.ctl-text .cv-ui-row-lb{color:#a9c8ff;text-decoration:underline;flex:0 1 auto}
  .cv-node.cv-ui-row.ctl-icon{justify-content:center;padding:0;background:rgba(255,255,255,.055);border-color:rgba(214,194,158,.3)}
  .cv-ui-icon-glyph{font-size:14px;color:#e6d9bf;line-height:1}
  .cv-node.cv-ui-row.ctl-toggle .cv-ui-switch{margin-left:auto}
  .cv-ui-switch.off{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.22)}
  .cv-ui-switch.off i{right:auto;left:1px;background:#8f8068}
  .cv-node.cv-ui-row.ctl-input{padding:0 4px;border-color:rgba(214,194,158,.32);background:rgba(0,0,0,.38)}
  .cv-ui-inputbox{flex:1;min-width:0;display:flex;align-items:center;gap:4px;border:1px solid rgba(214,194,158,.25);
    background:rgba(0,0,0,.3);border-radius:5px;padding:2px 6px;color:#b9ab90;font-size:11px}
  .cv-ui-inputbox em{font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-ui-inpico{color:#8f8068;font-size:11px}
  .cv-node.cv-ui-row.ctl-select{border-color:rgba(214,194,158,.3);background:rgba(0,0,0,.35)}
  .cv-ui-checkbox{flex-shrink:0;width:13px;height:13px;line-height:13px;border:1px solid rgba(214,194,158,.5);border-radius:3px;font-size:11px;
    line-height:10px;text-align:center;color:#1c1108}
  .cv-ui-checkbox.on{background:#e0b46a;border-color:#e0b46a}
  .cv-ui-radio{flex-shrink:0;width:11px;height:11px;border:1px solid rgba(214,194,158,.55);border-radius:50%;position:relative}
  .cv-ui-radio.on::after{content:"";position:absolute;inset:2px;border-radius:50%;background:#e0b46a}
  .cv-node.cv-ui-row.ctl-tab{padding:0;justify-content:center}
  .cv-ui-tabpill{font-size:11px;padding:2px 6px;border:1px solid rgba(214,194,158,.3);border-radius:10px;color:#b9ab90;
    white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
  .cv-ui-tabpill.on{background:#e0b46a;border-color:#e0b46a;color:#1c1108;font-weight:700}
  .cv-node.cv-ui-row.ctl-card{background:rgba(255,255,255,.035)}
  .cv-node.cv-ui-row.ctl-primary .cv-ui-hot,.cv-node.cv-ui-row.ctl-secondary .cv-ui-hot,.cv-node.cv-ui-row.ctl-danger .cv-ui-hot{
    position:absolute;right:3px;top:3px;width:4px;height:4px}
  .cv-node.cv-ui-row.ctl-icon .cv-ui-hot{display:none}
  .cv-node.cv-ui-fab{padding:0;border-radius:50%;border:1px solid rgba(224,180,106,.8);background:#e0b46a;color:#1c1108;
    display:flex;align-items:center;justify-content:center;font-size:23px;font-weight:800;z-index:6;
    box-shadow:0 8px 22px rgba(224,180,106,.35)}
  .cv-ui-fab .cv-cmts{position:absolute;right:-2px;top:-2px;font-size:11px}
  .cv-ui-tabbar{position:absolute;left:0;right:0;bottom:0;height:28px;display:flex;align-items:center;justify-content:space-around;
    border-top:1px solid rgba(214,194,158,.13);background:rgba(8,6,4,.72);border-radius:0 0 17px 17px;z-index:2;padding:0 6px}
  .cv-ui-tab{font-size:11px;color:#8f8068;padding:3px 7px;border-radius:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:72px}
  .cv-ui-tab.on{color:#1c1108;background:#e0b46a;font-weight:700}
  .cv-ui-cap{position:absolute;z-index:4;pointer-events:none;overflow:hidden}
  .cv-ui-cap-row{display:flex;align-items:center;gap:5px;min-width:0;height:20px}
  .cv-ui-no{flex-shrink:0;font-size:11px;font-weight:800;color:#1c1108;background:#e0b46a;border-radius:5px;padding:1px 5px;line-height:1.2}
  .cv-ui-cap-tt{min-width:0;flex:1;font-size:12.5px;font-weight:700;color:#f0e3c8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-ui-main-tag{flex-shrink:0;font-size:11px;color:#1c1108;background:#e0b46a;border-radius:4px;padding:1px 4px;font-weight:700}
  .cv-ui-entry-tag{flex-shrink:0;font-size:11px;color:#0d1a12;background:#7fd6a5;border-radius:4px;padding:1px 4px;font-weight:700}
  .cv-ui-cap-cmt{flex-shrink:0;font-size:11px;color:#c9a25e;border:1px solid rgba(201,162,94,.35);border-radius:4px;padding:0 4px}
  .cv-ui-cap-sum{font-size:11px;line-height:1.25;color:#b9ab90;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:1px}
  .cv-node.cv-ui-sec{padding:5px 7px;display:flex;flex-direction:column;gap:2px;overflow:hidden;z-index:2;box-shadow:none;
    background:rgba(255,255,255,.032);border:1px solid rgba(214,194,158,.18);border-radius:9px}
  .cv-node.cv-ui-sec.role-top{background:rgba(127,214,165,.055);border-color:rgba(127,214,165,.24)}
  .cv-node.cv-ui-sec.role-side{background:rgba(111,168,255,.05);border-color:rgba(111,168,255,.2)}
  .cv-node.cv-ui-sec.role-bottom{background:rgba(240,161,94,.05);border-color:rgba(240,161,94,.22)}
  .cv-node.cv-ui-sec.role-overlay{background:rgba(201,155,255,.06);border-color:rgba(201,155,255,.3);border-style:dashed}
  .cv-ui-sec-h{font-size:11px;font-weight:700;color:#e6d9bf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-ui-sec-s{font-size:11px;color:#a89a7d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-ui-sec .bd-tag.cv-cmts{align-self:flex-start;font-size:11px;margin-top:auto}
  .cv-node.cv-ui-row{padding:0 7px;display:flex;align-items:center;gap:5px;overflow:hidden;z-index:3;box-shadow:none;
    background:rgba(10,8,6,.72);border:1px solid rgba(214,194,158,.2);border-radius:7px;font-size:11px}
  .cv-node.cv-ui-row.role-top{border-color:rgba(127,214,165,.3)}
  .cv-node.cv-ui-row.role-side{border-color:rgba(111,168,255,.26)}
  .cv-node.cv-ui-row.role-bottom{border-color:rgba(240,161,94,.3)}
  .cv-node.cv-ui-row.role-overlay{border-style:dashed;border-color:rgba(201,155,255,.36)}
 /* z 序必须压过基础 row/sec 的 z-index:遮罩(4) < 触发按钮(5) < 浮层窗口(6) < 浮层内控件(7)。 */
  .cv-node.cv-ui-row.cv-ui-pop-child,.cv-node.cv-ui-sec.cv-ui-pop-child{z-index:7}
  .cv-node.cv-ui-row.cv-ui-pop-trigger,.cv-node.cv-ui-sec.cv-ui-pop-trigger{z-index:5}
  .cv-node.cv-ui-row.cv-ui-pop-child.cv-ui-pop-trigger,.cv-node.cv-ui-sec.cv-ui-pop-child.cv-ui-pop-trigger{z-index:8}
  .cv-node.cv-ui-row.cv-ui-row-fn{border-color:rgba(95,194,176,.35);background:rgba(20,34,31,.72)}
  .cv-ui-row-lb{flex:1;min-width:0;color:#e6d9bf;line-height:1.15;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal}
  .cv-ui-fn{flex-shrink:0;font-size:11px;color:#a9e6db;border:1px solid rgba(95,194,176,.4);border-radius:4px;padding:0 3px}
  .cv-ui-chev{flex-shrink:0;color:#8f8068;font-size:14px;line-height:1}
  .cv-ui-dotv{flex-shrink:0;width:4px;height:4px;border-radius:50%;background:#6f6252}
  .cv-ui-switch{flex-shrink:0;width:24px;height:13px;border-radius:8px;background:rgba(127,214,165,.25);border:1px solid rgba(127,214,165,.45);position:relative}
  .cv-ui-switch i{position:absolute;right:1px;top:1px;width:9px;height:9px;border-radius:50%;background:#7fd6a5}
  .cv-ui-btn{flex-shrink:0;font-size:11px;line-height:13px;color:#1c1108;background:#c9a25e;border-radius:5px;padding:0 5px}
  .cv-ui-inp{flex-shrink:0;font-size:11px;color:#8f8068;border:1px solid rgba(214,194,158,.2);border-radius:4px;padding:0 4px}
  .cv-ui-hot{flex-shrink:0;width:6px;height:6px;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.55);display:inline-block}
  .cv-ui-hot.inferred{box-shadow:0 0 0 1px rgba(255,255,255,.75)}
  .cv-ui-sec-h .cv-ui-hot{margin-left:3px;vertical-align:middle}
  .cv-node.cv-ui-row .bd-tag.cv-cmts{flex-shrink:0;font-size:11px}
  .cv-node.cv-ui-aux{padding:5px 7px;display:flex;align-items:center;gap:6px;z-index:2;overflow:hidden;
    background:rgba(20,16,11,.92);border:1px dashed rgba(201,162,94,.34);border-radius:9px}
  .cv-ui-aux-k{flex-shrink:0;width:18px;height:18px;border-radius:5px;background:rgba(201,162,94,.16);
    color:#e0c08f;font-size:11px;display:flex;align-items:center;justify-content:center;font-weight:700}
  .cv-ui-aux-b{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
  .cv-ui-aux-b b{font-size:11px;color:#e6d9bf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-ui-aux-b em{font-size:11px;color:#a89a7d;font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-ui-head{position:absolute;z-index:6;display:flex;align-items:flex-start;justify-content:space-between;gap:14px;pointer-events:none;overflow:hidden}
  .cv-ui-head-l{min-width:0;flex:1}
  .cv-ui-head-tt{font-size:14px;font-weight:800;color:#f0e3c8;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-ui-head-sum{font-size:11px;color:#b9ab90;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-ui-legend{display:flex;flex-wrap:wrap;gap:5px 10px;justify-content:flex-end;align-content:flex-start;max-width:58%}
  .cv-ui-lg{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#c9bda6;background:rgba(10,8,6,.5);
    border:1px solid rgba(214,194,158,.16);border-radius:7px;padding:2px 6px;white-space:nowrap}
  .cv-ui-lg b{font-size:11px;color:#8f8068;font-weight:600}
  .cv-ui-sw{display:inline-block;width:16px;height:3px;border-radius:2px;flex-shrink:0}
  .cv-ui-mode-btn{position:absolute;right:10px;top:36px;z-index:8;background:var(--bcv-float-bg);border:1px solid var(--border-soft);
    color:var(--bronze);font-size:11px;cursor:pointer;padding:4px 10px;border-radius:8px}
  .cv-ui-mode-btn:hover{color:var(--accent-bright);border-color:var(--bronze)}
 /* 一条流线全段同色同粗细同虚实:主线/引线/框外段共用 inline stroke 属性,这里不再按类改宽度或透明度。 */
  .bf-cv-edges .bfe-ui-flow{fill:none;stroke-linejoin:round;stroke-linecap:round}
  .bf-cv-edges .bfe-ui-flow.uimain{opacity:1}
  .bf-cv-edges .bfe-ui-leader{fill:none;stroke-linejoin:round;stroke-linecap:round}
  .bf-cv-edges .bfe-ui-dot{stroke:var(--bcv-edge-dot-bd);stroke-width:1}
  .bf-cv-edges .bfe-ui-label-bg{fill:var(--bcv-edge-label-bg);stroke-width:1;rx:4}
  .bf-cv-edges .bfe-ui-label{font-size:11px;font-weight:600}
  .bf-cv-edges .cv-edge:hover .bfe-ui-dot{r:4.4px}
  body.light .cv-node.cv-ui-screen{background:#fffdf8;border-color:rgba(90,70,40,.28)}
  body.light .cv-ui-screen .cv-ui-nav,body.light .cv-ui-cap-tt,body.light .cv-ui-row-lb{color:var(--bcv-title-fg)}
  body.light .cv-node.cv-ui-row{background:#fbf6ec;color:#2a2118}
  body.light .cv-ui-cap-sum{color:#6b5c4a}
  body.light .cv-ui-head-tt{color:#2a2118}
  body.light .cv-ui-head-sum{color:#6b5c4a}
  body.light .cv-ui-lg{color:#3a2f22;background:#fffdf8;border-color:rgba(90,70,40,.2)}
  body.light .cv-ui-lg b{color:#8a7a5a}
  .bf-cv-edges path.bfe-main{stroke:var(--bcv-edge-main)!important;stroke-width:3.2px!important;filter:drop-shadow(0 0 2px var(--bcv-pgmain-glow))}
  .bf-cv-edges path.bfe-back{stroke:var(--bcv-edge-back)!important;stroke-width:1.2px!important;stroke-dasharray:5 4!important;opacity:.85}
  .bf-cv-edges path.bfe-selfloop{stroke-width:1.4px}
 /* K:图例曾是画布底部绝对定位浮层(position:absolute;bottom:10px),适配时靠
 legendReserve 预留高度躲它——但 fitMinK 可读下限一夹,内容一超就钻到图例底下被盖住
 (实测 docs/code/ui-func/contract 底排卡被压一两行)。改为画布外的底部占位条:
 #cvHost 在 .board-graph/.bf-graph 的 flex 列里 flex:1 自然收缩,图例排在它下面,
 永不覆盖卡片,适配也不必再预留(见 cvFitNow)。 */
  .cv-rail{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;min-height:0;max-width:100%;row-gap:4px}
  .cv-rail .cv-legend{flex:0 0 auto;max-width:100%}
  .cv-legend{display:flex;gap:12px;align-items:center;font-size:10px;color:var(--bcv-legend-fg);background:var(--bcv-legend-bg);border:1px solid var(--bcv-legend-bd);border-radius:8px;padding:4px 10px;backdrop-filter:blur(6px);pointer-events:none;max-width:70%}
  .cv-legend .lg-main{display:inline-block;width:22px;height:0;border-top:3px solid var(--bcv-edge-main);vertical-align:middle}
  .cv-legend .lg-branch{display:inline-block;width:22px;height:0;border-top:1.5px solid var(--bcv-edge-line);vertical-align:middle} /* 白板修复:与 bfe-nav 同步改青铜 */
  .cv-legend .lg-back{display:inline-block;width:22px;height:0;border-top:1.2px dashed var(--bcv-edge-back);vertical-align:middle}
  .cv-legend .lg-box{display:inline-block;width:14px;height:10px;border:1.5px solid var(--bcv-accent-2);border-radius:3px;background:rgba(201,162,94,.12);vertical-align:middle}
 /* 关系图例:边按 kind 分色 + 虚线=自动推导待核实(与 bfe-* 描边色同源) */
  .cv-legend .lg-call{display:inline-block;width:22px;height:0;border-top:2px solid var(--bcv-edge-call);vertical-align:middle}
  .cv-legend .lg-data{display:inline-block;width:22px;height:0;border-top:2px solid var(--bcv-edge-data);vertical-align:middle}
  .cv-legend .lg-verify{display:inline-block;width:22px;height:0;border-top:2px dashed var(--bcv-edge-verify);vertical-align:middle}
  .cv-legend .lg-nav{display:inline-block;width:22px;height:0;border-top:1.8px solid var(--bcv-edge-line);vertical-align:middle}
  .cv-legend .lg-virtual{display:inline-block;width:22px;height:0;border-top:1.2px dashed var(--bcv-edge-line);vertical-align:middle}
  .cv-legend .lg-tag{color:var(--bcv-legend-fg-dim)}
 /* ---- fixH2 设计板「一眼看懂」流动布局:泳道虚线框/主线粗绿/入口出口角标/编号/副标题条 ---- */
  .cv-lane{position:absolute;border:1px dashed var(--bcv-lane-bd);border-radius:18px;background:var(--bcv-lane-bg);pointer-events:none;z-index:0} /* 主题跟随:兜底线/底改走变量(实际色相由渲染侧 CV_LANE_HUES 内联 5 色循环=阶段识别功能色,保留) */
  .cv-lane-orphan{border-style:dotted;border-color:var(--bcv-lane-orphan-bd);background:var(--bcv-lane-orphan-bg)}
  .cv-lane-h{position:absolute;left:14px;top:10px;display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:600;letter-spacing:.4px;white-space:nowrap;color:var(--bcv-lane-h-fg)}
  .cv-lane-h b{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--bcv-lane-no-fg);background:var(--bcv-lane-2,#6f9ac4);border-radius:4px;padding:1px 5px;letter-spacing:0}
 /* A:宽板折行后同一条泳道按行拆分,每段头标注「第 i/N 段」(段与段不连续,编号相同) */
  .cv-lane-seg{font-style:normal;font-size:11px;font-weight:400;color:var(--bcv-lane-seg-fg-strong,var(--bcv-lane-seg-fg));margin-left:4px} /* 段序号走强对比档(暗底 #9a9083 / 浅底各主题深一档),治 --faint 压泳道底 2.46:1 */
  .cv-legend .lg-wrap{display:inline-block;font-size:11px;color:var(--bronze);border:1px solid var(--border-soft);border-radius:6px;padding:0 5px}
  .cv-flow-world .cv-node{width:208px;height:116px;padding-bottom:6px;display:flex;flex-direction:column}
 /* 工程师图形态(code):C4 类型/技术行 + 组件/存储/决策/起终点形状 + 关系线型 */
  .cv-code-world .cv-node.cv-code-node{background:var(--bcv-code-bg);border-color:var(--bcv-code-bd);border-radius:8px;overflow:hidden;box-shadow:0 4px 14px var(--bcv-card-shadow)}
 /* 文字清晰度:浅底主题里 code 卡标题/摘要改走与卡底同源的 --bcv-code-fg(治「深字压深底」);深底主题不参与=默认零漂移 */
  body.light .cv-code-world .cv-node.cv-code-node,body.theme-sand .cv-code-world .cv-node.cv-code-node,body.theme-olive .cv-code-world .cv-node.cv-code-node,body.theme-plum .cv-code-world .cv-node.cv-code-node,body.theme-ink .cv-code-world .cv-node.cv-code-node{--cv-head-fg:var(--bcv-code-fg);--cv-sub-fg:var(--bcv-code-sum-fg)}
 /* code flow:方法/阶段分组=实色分区(黄/蓝/绿/粉),标题条浮左上;代码卡内放伪代码行 */
  .cv-code-world .cv-lane{border-style:solid;border-width:1.2px;border-radius:12px}
  .cv-code-world .cv-lane .cv-lane-h{left:12px;top:8px;padding:2px 8px;border-radius:6px;background:var(--bcv-lane-h-bg);font-size:10.5px;letter-spacing:0}
  .cv-code-world .cv-lane .cv-lane-h b{font-size:11px}
  .cv-code-node .cv-code-lines{margin:4px 10px 0;font-family:var(--mono);font-size:11px;line-height:1.35;color:var(--bcv-code-fg);max-height:60px;overflow:hidden}
  .cv-code-lines .cv-cl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:1px solid var(--bcv-code-line-bd);padding-left:5px;margin-bottom:1px}
  .cv-code-lines .cv-cl:first-child{border-left-color:var(--bcv-code-line-first)}
  .cv-code-node .cv-c4-kind{display:flex;align-items:center;gap:4px;padding:3px 10px 0;font-family:var(--mono);font-size:11px;color:var(--bcv-code-kind-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-code-node .cv-c4-glyph{color:var(--bcv-code-glyph);font-size:11px;line-height:1}
  .cv-code-node .cv-c4-type{font-weight:700}
  .cv-code-node .cv-c4-tech{color:var(--bcv-code-tech-fg);background:var(--bcv-code-tech-bg);border:1px solid var(--bcv-code-tech-bd);border-radius:3px;padding:0 3px;font-size:11px}
  .cv-code-node .cv-sum{font-size:11px;line-height:1.35;color:var(--bcv-code-sum-fg);max-height:40px;overflow:hidden}
  .cv-code-world .cv-node.cv-code-node.k-module{border-color:var(--bcv-code-bd-module);background:var(--bcv-code-bg-module)}
  .cv-code-world .cv-node.cv-code-node.k-function{border-color:var(--bcv-code-bd-fn);background:var(--bcv-code-bg-fn)}
  .cv-code-world .cv-node.cv-code-node.k-tool,.cv-code-world .cv-node.cv-code-node.k-http{border-color:var(--bcv-code-bd-tool);background:var(--bcv-code-bg-tool)}
  .cv-code-world .cv-node.cv-code-node.k-agent{border-color:var(--bcv-code-bd-agent);border-radius:20px 20px 8px 8px;background:var(--bcv-code-bg-agent)}
  .cv-code-world .cv-node.cv-code-node.k-io{border-color:var(--bcv-code-bd-io);background:var(--bcv-code-bg-io)}
  .cv-code-world .cv-node.cv-code-node.k-decision{border-color:var(--bcv-code-bd-dec);background:var(--bcv-code-bg-dec);box-shadow:0 0 0 1px var(--bcv-diamond-glow),0 4px 14px var(--bcv-card-shadow)}
  .cv-code-world .cv-node.cv-code-node.k-decision .cv-c4-kind{color:var(--bcv-diamond-fg)}
  .cv-code-world .cv-node.cv-code-node.k-start,.cv-code-world .cv-node.cv-code-node.k-end{border-radius:999px;background:var(--bcv-code-bg-term);border-color:var(--bcv-code-bd-term)}
  .cv-code-world .bf-cv-edges path.bfe-call{stroke:var(--bcv-code-edge-call);stroke-width:1.8}
  .cv-code-world .bf-cv-edges path.bfe-data{stroke:var(--bcv-code-edge-data);stroke-dasharray:6 4;stroke-width:1.7}
  .cv-code-world .bf-cv-edges path.bfe-verify{stroke:var(--bcv-code-edge-verify);stroke-dasharray:2 4;stroke-width:1.6}
  .cv-legend-code{max-width:100%;flex-wrap:wrap;row-gap:2px;font-size:11px}
  .cv-legend-code .lg-c4{display:inline-block;width:11px;height:9px;border-radius:2px;vertical-align:middle;margin-right:2px}
  .cv-legend-code .c4-person{border-radius:50% 50% 3px 3px;background:#2f6f8f;border:1px solid #5aa0c0}
  .cv-legend-code .c4-system{background:#6f6b63;border:1px solid #8f8a80}
  .cv-legend-code .c4-container{background:rgba(91,142,201,.35);border:1px solid #5b8ec9}
  .cv-legend-code .c4-component{background:rgba(111,168,255,.35);border:1px solid #6fa8ff}
  .cv-legend-code .c4-store{background:rgba(111,154,111,.35);border:1px solid #6f9a6f;border-radius:5px/3px}
  .cv-legend-code .c4-decision{width:9px;height:9px;transform:rotate(45deg);background:rgba(217,179,108,.35);border:1px solid #d9b36c;border-radius:1px;margin:0 4px}
  .cv-legend-code .lg-ccall,.cv-legend-code .lg-cdata,.cv-legend-code .lg-cverify{display:inline-block;width:20px;height:0;border-top:2px solid #82b8e8;vertical-align:middle}
  .cv-legend-code .lg-cdata{border-top-color:#6fbf9f;border-top-style:dashed}
  .cv-legend-code .lg-cverify{border-top-color:#d9b36c;border-top-style:dotted}
 /* code 板右侧栏:验收/风险/测试从主架构图剥离,避免 16 节点/31 边糊成一片 */
  .cv-code-side{position:absolute;right:10px;bottom:52px;z-index:7;width:250px;max-height:38%;overflow:auto;
    background:var(--bcv-side-bg);border:1px solid var(--bcv-side-bd);border-radius:10px;padding:7px 9px 8px;
    box-shadow:0 8px 22px var(--bcv-card-shadow);backdrop-filter:blur(6px);font-size:11px;color:var(--bcv-side-fg)}
  .cv-code-side>summary{list-style:none;cursor:pointer}
  .cv-code-side>summary::-webkit-details-marker{display:none}
  .cv-code-side>summary::before{content:"▸";color:var(--bcv-accent);font-size:11px;margin-right:2px}
  .cv-code-side[open]>summary::before{content:"▾"}
  .cv-code-side-title{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--bcv-side-fg-2);padding-bottom:4px;border-bottom:1px solid var(--bcv-side-bd-mid)}
  .cv-code-side-title b{font-family:var(--mono);color:var(--bcv-accent)}
  .cv-code-side-title span{font-weight:400;color:var(--bcv-side-fg-dim);font-size:11px}
  .cv-code-side-card{border-top:1px solid var(--bcv-side-bd-soft);padding:5px 0 4px}
  .cv-code-side-card:first-of-type{border-top:none}
  .cv-code-side-h{display:flex;align-items:baseline;gap:5px;font-size:11px;color:var(--bcv-side-fg-3)}
  .cv-code-side-h b{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cv-code-side-h span{flex-shrink:0;font-family:var(--mono);font-size:11px;color:var(--bcv-side-fg-dim2)}
  .cv-code-side-card p{margin:2px 0 0;color:var(--bcv-side-p-fg);line-height:1.35;font-size:11px;max-height:36px;overflow:hidden}
  .cv-code-side-acc{display:flex;gap:3px;align-items:center;margin-top:3px;flex-wrap:wrap}
  .cv-code-side-acc .cside-ac{font-family:var(--mono);font-size:11px;color:#d9b36c;border:1px solid rgba(217,179,108,.35);border-radius:3px;padding:0 3px}
  .cv-code-side-acc i{font-style:normal;font-size:11px;color:#7f93a8}
  .cv-code-baseline-tag{font-family:var(--mono);font-size:11px;color:#7fa8c9;border:1px dashed rgba(120,160,200,.35);border-radius:3px;padding:0 4px}
 /* 流程图形态:decision 菱形 / start-end 药丸(与示例图同读法) */
  .cv-code-node.cv-decision-diamond{background:transparent!important;border:none!important;box-shadow:none!important;overflow:visible!important}
  .cv-code-node.cv-decision-diamond .cv-dia{position:absolute;left:50%;top:50%;width:132px;height:132px;transform:translate(-50%,-50%) rotate(45deg);
    background:var(--bcv-diamond-bg);border:2px solid var(--bcv-diamond-bd);border-radius:7px;box-shadow:0 0 0 1px var(--bcv-diamond-glow),0 6px 18px var(--bcv-card-shadow)}
  .cv-code-node.cv-decision-diamond .cv-dia-txt{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:20px 26px}
  .cv-code-node.cv-decision-diamond .cv-dia-txt b{font-size:11px;color:var(--bcv-diamond-fg);line-height:1.25}
  .cv-code-node.cv-decision-diamond .cv-dia-txt span{margin-top:3px;font-size:11px;color:var(--bcv-diamond-fg-dim);line-height:1.3;max-height:32px;overflow:hidden}
  .cv-code-node.cv-code-pill{background:var(--bcv-pill-bg)!important;border-color:var(--bcv-pill-bd)!important;border-radius:999px!important;
    display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 14px;box-shadow:0 4px 14px var(--bcv-card-shadow)}
  .cv-code-node.k-end.cv-code-pill{background:var(--bcv-pill-end-bg)!important;border-color:var(--bcv-pill-end-bd)!important}
  .cv-pill-label{font-size:12px;font-weight:700;color:var(--bcv-pill-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .cv-code-pill small{margin-top:2px;font-size:11px;color:var(--bcv-pill-fg-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
 /* 仓库关系上屏:targets 文件名行(.cv-file-foot)+ 药丸/菱形上的小号变更徽标。
 徽标绝对定位挂在形状角上,不参与药丸(220×64)/菱形(132×132)的列布局预算 → 不撑破几何。 */
 /* 排版治「看不懂」:文件名之间给 .cv-file-sep(·)分隔 + 每个 chip 可收缩省略(min-width:0),
 260 宽卡里 2 个文件名 + +N + 徽标一行不粘连;徽标 8px→9px/15px(k=0.7 折算约 6.3px,原 5.6px 看不见)。 */
  .cv-file-foot{display:flex;align-items:center;gap:4px;margin:3px 10px 0;font-size:11px;line-height:15px;color:var(--bcv-file-foot-fg);white-space:nowrap;overflow:hidden}
  .cv-file-name{flex:0 1 auto;min-width:0;font-family:var(--mono);border:1px solid var(--bcv-file-name-bd);border-radius:4px;padding:0 4px;
    color:var(--bcv-file-name-fg);background:var(--bcv-file-name-bg);overflow:hidden;text-overflow:ellipsis;max-width:112px}
  .cv-file-sep{flex:0 0 auto;font-style:normal;font-size:11px;color:var(--bcv-file-sep-fg)}
  .cv-file-more{flex:0 0 auto;font-style:normal;font-size:11px;color:var(--bcv-file-more-fg)}
  .cv-file-foot .bd-tag.cv-chg{margin-left:auto;flex-shrink:0;font-size:11px;line-height:15px;padding:0 4px}
 /* 「看得懂」:卡脚符号 chip(name@basename:line)——颜色沿用文件名 chip 的令牌组,
 只是边框改虚线区分「这里是符号锚,不是文件」。卡高是布局常量(code flow 176),所以 chip 行
 必须单行不换行:flex 不 wrap + 省略号(见 .cv-file-foot 的 nowrap/overflow:hidden)。 */
  .cv-sym-name{flex:0 1 auto;min-width:0;font-family:var(--mono);border:1px dashed var(--bcv-file-name-bd);border-radius:4px;padding:0 4px;
    color:var(--bcv-file-name-fg);background:var(--bcv-file-name-bg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;cursor:default}
 /* 层标注带(现状层/变更层)+ 层高亮:dim 只降透明,不改任何布局量/几何/连线——
 opacity 不影响 flex/绝对定位,卡片位置与边端口零漂移。 */
  .cv-lbar{gap:4px}
  .cv-laychip{cursor:pointer;font-weight:600}
  .cv-laychip.on{background:var(--bcv-float-on-bg,var(--hover-bg));border-color:var(--bronze,#c98b52);color:var(--text)}
  .cv-node.cv-layer-dim{opacity:.35}
  .cv-node.cv-layer-on{outline:1px dashed var(--bronze,#c98b52);outline-offset:1px}
  #cvSvgHost [data-node-id].cv-layer-dim{opacity:.35}
  #cvSvgHost [data-node-id].cv-layer-on rect,#cvSvgHost [data-node-id].cv-layer-on path,#cvSvgHost [data-node-id].cv-layer-on polygon{stroke:var(--bronze,#c98b52)!important;stroke-width:2.2!important}
 /* 主题横幅(.cv-theme-band):横贯板首的主题条——绝对定位浮在画布顶部、指上不挡卡;
 它只表达「这块板在讲什么」,不参与 flow 布局、不参与连线、不进小地图。 */
  .cv-theme-band{position:absolute;left:12px;top:44px;z-index:6;max-width:calc(100% - 190px);pointer-events:none;
    display:flex;align-items:baseline;gap:8px;padding:4px 10px 5px;border-radius:10px;
    border:1px solid var(--bcv-thead-bd);background:var(--bcv-thead-bg);box-shadow:var(--bcv-thead-shadow)}
  .cv-theme-band b{font-size:12px;font-weight:800;color:var(--bcv-pill-fg,#f4e8cd);white-space:nowrap}
  .cv-theme-band span{font-size:11px;color:var(--bcv-file-foot-fg);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;max-width:820px}
 /* 逻辑层口径:modify/delete 卡上的一行「现状:<before>」(「改这里」不是「计划」)。
 颜色沿用已有令牌(--bcv-side-fg-dim 系的一档弱字色 + 代码行左边线),默认视觉即当前主题。 */
  .cv-before{margin:3px 10px 0;padding:0 5px;border-left:1px solid var(--bcv-code-line-bd);
    font-size:11px;line-height:15px;color:var(--bcv-side-fg-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cv-code-pill .bd-tag.cv-chg{position:absolute;right:8px;top:1px;margin:0;font-size:11px;line-height:15px;padding:0 4px;z-index:2;opacity:.95}
  .cv-decision-diamond .bd-tag.cv-chg{position:absolute;right:4px;top:2px;margin:0;font-size:11px;line-height:15px;padding:0 4px;z-index:2;opacity:.95}
 /* 板型画像:画布顶部类型/规模/阶段覆盖浮层(不随世界缩放,始终可读) */
  .cv-type-head{position:absolute;left:12px;top:8px;z-index:7;max-width:calc(100% - 24px);pointer-events:none;
    background:var(--bcv-thead-bg);border:1px solid var(--bcv-thead-bd);border-radius:10px;padding:5px 9px 6px;
    box-shadow:var(--bcv-thead-shadow);font-size:11px;color:var(--bcv-thead-fg)}
  .cv-type-head-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
  .cv-type-badge{font-size:11px;font-weight:800;border:1px solid;border-radius:6px;padding:0 6px;line-height:16px;white-space:nowrap}
  .cv-type-scale{font-family:var(--mono);font-size:11px;color:#a9e6db;border:1px solid rgba(95,194,176,.35);border-radius:5px;padding:0 4px}
  .cv-type-scale.warn{color:#e6cfa0;border-color:rgba(201,162,94,.45)}
  .cv-type-meta{font-size:11px;color:#a89a7d;white-space:nowrap}
  .cv-type-warn{font-size:11px;color:#f0a15e;border:1px solid rgba(240,161,94,.4);border-radius:5px;padding:0 4px;white-space:nowrap}
  .cv-type-stages{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;max-height:34px;overflow:hidden}
  .cv-type-stage{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:#c9bda6;border:1px solid rgba(214,194,158,.22);
    border-radius:5px;padding:0 4px;line-height:14px;white-space:nowrap}
  .cv-type-stage b{font-family:var(--mono);font-size:11px}
  .cv-type-stage.missing{border-style:dashed;color:#8f8068}
  .cv-type-rule{margin-top:3px;font-size:11px;color:#8f8068;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:960px}
  .cv-flow-world .cv-node .cv-head{padding:8px 10px 3px}
  .cv-flow-world .cv-node .cv-sum{margin:2px 8px 0;padding:3px 7px;background:var(--hover-bg);border:1px solid var(--border-soft);border-radius:6px;font-size:11px;line-height:1.4;color:var(--cv-sub-fg);max-height:31px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical} /* 主题跟随:底色/边/字色改走变量(原 rgba(255,255,255,.055)/#d8c9a8) */
 /* 板型节点条:角色/硬规则徽标 + flow 关键步骤/if-else(卡高由引擎 nodeH 撑开) */
  .cv-flow-world .cv-node .cv-type-line{display:flex;gap:3px;align-items:center;margin:3px 8px 0;overflow:hidden;white-space:nowrap}
  .cv-type-chip{flex-shrink:0;max-width:92px;overflow:hidden;text-overflow:ellipsis;font-size:11px;line-height:15px;
    border:1px solid rgba(214,194,158,.24);border-radius:4px;padding:0 4px;color:var(--bcv-chip-info-fg)}
  .cv-type-chip.t-role{color:var(--bcv-chip-role-fg);border-color:rgba(224,180,106,.45);background:rgba(224,180,106,.08)}
  .cv-type-chip.t-ok{color:var(--bcv-chip-ok-fg);border-color:rgba(95,194,176,.42);background:rgba(95,194,176,.07)}
  .cv-type-chip.t-warn{color:var(--bcv-chip-warn-fg);border-color:rgba(240,161,94,.42);background:rgba(240,161,94,.07)}
  .cv-type-chip.t-bad{color:var(--bcv-chip-bad-fg);border-color:rgba(242,124,141,.42);background:rgba(242,124,141,.07)}
  .cv-type-chip.t-branch{color:var(--bcv-chip-branch-fg);border-color:rgba(111,168,255,.4);background:rgba(111,168,255,.07)}
  .cv-type-chip.t-before{color:var(--bcv-chip-before-fg);border-color:rgba(139,129,116,.5);text-decoration:line-through}
  .cv-type-chip.t-target{color:var(--bcv-chip-target-fg);border-color:rgba(111,168,255,.35)}
  .cv-type-chip.t-metric{color:var(--bcv-chip-metric-fg);border-color:rgba(224,180,106,.45);font-family:var(--mono)}
  .cv-flow-world .cv-node .cv-type-flow{margin:2px 8px 0;padding:2px 5px;border-radius:5px;background:rgba(111,168,255,.07);
    border:1px solid rgba(111,168,255,.2);font-size:11px;line-height:1.35;color:#b9cbe8;max-height:31px;overflow:hidden;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .cv-flow-world .cv-node .cv-foot{margin-top:auto;padding:4px 10px 0}
  .cv-flow-world .cv-node.cv-flow-main{border-color:#4fbf7a;box-shadow:0 0 0 1px rgba(79,191,122,.45),0 6px 18px rgba(0,0,0,.45)}
  .cv-flow-world .cv-node.cv-node-entry{border-width:2px;border-color:#4fbf7a}
  .cv-flow-world .cv-node.cv-node-exit{border-width:2px;border-color:#e0b46a}
  .cv-no{position:absolute;left:8px;top:-10px;z-index:3;font-family:var(--mono);font-size:11px;font-weight:700;color:#0d0a06;background:#b9a887;border-radius:5px;padding:1px 5px;letter-spacing:.5px}
  .cv-entry-badge{position:absolute;right:8px;top:-11px;z-index:3;font-size:var(--fs-chip);font-weight:700;color:#07220f;background:#4fbf7a;border-radius:5px;padding:2px 7px}
  .cv-exit-badge{position:absolute;right:8px;top:-11px;z-index:3;font-size:var(--fs-chip);font-weight:700;color:#2a1a05;background:#e0b46a;border-radius:5px;padding:2px 7px}
  .cv-node-entry .cv-exit-badge{right:56px}
 /* 阶段卡(ph-*,「00 流程」泳道):当前阶段强调色描边 + ◀ 指向,「不涉及」整卡降透明。
 阶段卡不是工作流模块——不挂端口、不挂 change 角标(渲染侧已不输出),这里只管视觉层级。 */
  .cv-flow-world .cv-node.cv-ph{border-style:dashed;border-color:#8a7350;background:rgba(20,15,10,.92)}
  .cv-flow-world .cv-node.cv-ph-cur{border-style:solid;border-width:2px;border-color:var(--bronze);
    box-shadow:0 0 0 1px rgba(201,143,69,.45),0 0 14px rgba(201,143,69,.28)}
  .cv-flow-world .cv-node.cv-ph-cur .cv-head{color:var(--accent-bright)}
  .cv-flow-world .cv-node.cv-ph-skip{opacity:.4}
  .cv-lane[data-lane="g:00 流程"]{border-style:solid;border-color:#8a7350}
  .bf-cv-edges path.bfe-flow{stroke:#6b5c4a;stroke-width:1.3px}
  .cv-flow-world .bf-cv-edges path.bfe-main{stroke:var(--bcv-flow-main,#4fbf7a)!important;stroke-width:3.6px!important;stroke-dasharray:14 6;animation:dashFlow 1.1s linear infinite;filter:drop-shadow(0 0 3px rgba(79,191,122,.55))}
  .cv-flow-world .bf-cv-edge-label{font-size:11px;stroke-width:3.5px}
  .cv-flow-world .bf-cv-edge-label-main{fill:#d6f5e2;font-weight:700;font-size:10.5px}
  .bf-cv-edge-label-bg{fill:rgba(236,225,209,.10);stroke:rgba(236,225,209,.16);stroke-width:.6}
  .bf-cv-edge-label-bg.main{fill:rgba(79,191,122,.16);stroke:rgba(79,191,122,.35)}
  .bf-cv-world.z-low .bf-cv-edge-label-bg{display:none}
 /* code flow:主线=一条实心绿线(示例图),不闪动;正交折线在列间/底部走 */
  .cv-code-world .bf-cv-edges path.bfe-main{stroke:var(--bcv-flow-main,#4fbf7a)!important;stroke-width:2.6px!important;stroke-dasharray:none!important;animation:none!important;filter:drop-shadow(0 0 2px rgba(79,191,122,.45))}
  .cv-legend-flow{left:0}
  .cv-legend .lg-entry,.cv-legend .lg-exit{display:inline-block;width:16px;height:10px;border-radius:3px;vertical-align:middle}
  .cv-legend .lg-entry{background:#4fbf7a}
  .cv-legend .lg-exit{background:#e0b46a}
  .cv-legend .lg-lane{display:inline-block;width:16px;height:10px;border:1.2px dashed #6f9ac4;border-radius:4px;background:rgba(96,140,190,.10);vertical-align:middle}
  .cv-legend-flow .lg-main{border-top-color:var(--bcv-flow-main,#4fbf7a);border-top-width:3px}
  .cv-node:hover{border-color:var(--bronze)}
  .cv-node.on{border-color:var(--accent-bright);box-shadow:0 0 0 1px var(--accent-bright),0 6px 18px rgba(0,0,0,.45)}
  .cv-node.dragging{cursor:grabbing;z-index:5}
  .cv-node .cv-head{display:flex;align-items:center;gap:6px;padding:7px 10px 4px;font-size:12px;color:var(--cv-head-fg);background:var(--bcv-card-head-bg);font-weight:600;flex-wrap:wrap} /* 主题跟随:字色由固定浅色(#eee2c6)改走卡内变量 --cv-head-fg(默认 --text;深底线框变体自填浅色),light/七套主题自动跟随 */
 /* f4 卡片头信息预算:标题独占剩余宽度且可省略(title=全名兜底);徽标一律不压缩(否则宽度不足时先挤标题再溢出错位) */
 /* 头信息分层(治 k=1 时 5/7 主干卡标题被 ellipsis):卡宽 208 定死,头行原来
 kind20+验收「验 x/y」37+变更「新增」28 全部常驻 → 标题槽只剩 71–73px。改为 .cv-head 允许换行 +
 标题给 min-width 下限:头行只留「kind 图标 + 标题」占满整行宽度,**验收/变更徽标自动折到第二行**。
 选 CSS 折行而非把徽标搬进 .cv-foot 的理由:①.cv-acc 仍留在 .cv-head 内,boardread.spec 的 ④⑤
 按 head 定位与 cvPatchCanvas 的 querySelector(".cv-acc") 增量补丁都不用改;②DOM 顺序不动,
 结构签名(cvStructSig)零变化,不触发整板重建。 */
  .cv-node .cv-title{flex:1;min-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cv-node .cv-head .bd-tag{flex-shrink:0}
 /* 阶段卡(ph-*,46px 窄条)不参与折行:两行头会撑破窄条,保持不换行(标题按原口径截断) */
  .cv-flow-world .cv-node.cv-ph .cv-head{flex-wrap:nowrap}
  .cv-flow-world .cv-node.cv-ph .cv-title{min-width:0}
  .cv-kind{flex-shrink:0;width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#0b0806}
  .cv-kind.cv-k-llm{background:#6172f3;color:#fff}.cv-kind.cv-k-tool{background:#1570ef;color:#fff}.cv-kind.cv-k-decision{background:#067f96;color:#fff}
  .cv-kind.cv-k-io{background:#155eef;color:#fff}.cv-kind.cv-k-function{background:#1570ef;color:#fff}.cv-kind.cv-k-module{background:#1570ef;color:#fff}.cv-kind.cv-k-note{background:#8a8a8a;color:#fff}
 /* 七期:工作流类型色板(对照通用工作流产品的类型配色) */
  .cv-kind.cv-k-start{background:#155eef;color:#fff}.cv-kind.cv-k-end{background:#f79009;color:#fff}.cv-kind.cv-k-http{background:#875bf7;color:#fff}
  .cv-kind.cv-k-template{background:#1570ef;color:#fff}.cv-kind.cv-k-aggregate{background:#1570ef;color:#fff}.cv-kind.cv-k-loop{background:#067f96;color:#fff}
  .cv-kind.cv-k-retrieval{background:#039855;color:#fff}.cv-kind.cv-k-classifier{background:#039855;color:#fff}.cv-kind.cv-k-agent{background:#6172f3;color:#fff}
 /* 页面结构板族 */
  .cv-kind.cv-k-page{background:#c9a25e;color:#241a08}.cv-kind.cv-k-section{background:#8a7a5a;color:#fff}.cv-kind.cv-k-component{background:#5a5346;color:#fff}.cv-kind.cv-k-nav{background:#6172f3;color:#fff}
 /* 工作流板可执行节点族(参照 dify 类型配色:脚本=蓝/测试=绿/代理=紫/条件=青/并行=橙/通知=金) */
  .cv-kind.cv-k-wf-script{background:#1570ef;color:#fff}.cv-kind.cv-k-wf-test{background:#039855;color:#fff}.cv-kind.cv-k-wf-agent{background:#6172f3;color:#fff}
  .cv-kind.cv-k-wf-condition{background:#067f96;color:#fff}.cv-kind.cv-k-wf-parallel{background:#f79009;color:#241a08}.cv-kind.cv-k-wf-notify{background:#c9a25e;color:#241a08}
 /* 运行态高亮:running=金框呼吸/done=绿框/failed=红框;角标=状态+耗时 */
  .cv-node.wf-running{border-color:#e0b46a;box-shadow:0 0 0 1px rgba(224,180,106,.75),0 0 14px rgba(224,180,106,.28);animation:wf-pulse 1.2s ease-in-out infinite}
  .cv-node.wf-done{border-color:#5aa06a;box-shadow:0 0 0 1px rgba(90,160,106,.55)}
  .cv-node.wf-failed{border-color:#e08a7a;box-shadow:0 0 0 1px rgba(224,138,122,.6)}
  @keyframes wf-pulse{0%,100%{box-shadow:0 0 0 1px rgba(224,180,106,.75),0 0 6px rgba(224,180,106,.15)}50%{box-shadow:0 0 0 1px rgba(224,180,106,.9),0 0 16px rgba(224,180,106,.45)}}
  .cv-wf-badge{font-size:var(--fs-chip);font-weight:700;border-radius:6px;padding:1px 5px;flex-shrink:0}
  .cv-wf-badge.running{background:rgba(224,180,106,.18);color:#e0b46a}
  .cv-wf-badge.done{background:rgba(90,160,106,.2);color:#7ec492}
  .cv-wf-badge.failed{background:rgba(224,138,122,.2);color:#e8a294}
 /* C:固定浅色(深底内联同根因)。
 * 白板易读性 w3:摘要默认**单行**(经验证 100% 下 52/60 摘要被 max-height 裁成毛刺),
 * hover 展开到 6 行;**卡片 z-index 提升**避免展开后压到邻卡下面看不见(父子 span 不参与层叠,
 * 抬卡本身才有效);全文另外走 .cv-sum 的 title 属性(悬停可看完整摘要)。 */
  .cv-node .cv-sum{font-size:11px;color:var(--cv-sub-fg);padding:0 10px;line-height:1.45;max-height:16px;overflow:hidden;
    display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;text-overflow:ellipsis} /* 主题跟随:摘要字色 #c4b494→var(--cv-sub-fg)(默认 --muted,深底线框变体自填浅色) */
  .cv-node:hover{z-index:6}
  .cv-node:hover .cv-sum{-webkit-line-clamp:6;max-height:92px;background:var(--sunken);border-radius:6px;padding-bottom:2px} /* 同上:hover 展开的压底由 rgba(0,0,0,.28) 改走 --sunken(浅色主题自动变成淡底) */
 /* 白板易读性 w1/w2:写者过滤 chip 条(画布左上浮动)+ 密度分层计数块(.cv-fold) */
  .cv-wbar{position:absolute;left:10px;top:30px;z-index:8;display:flex;flex-wrap:wrap;gap:4px;align-items:center;max-width:calc(100% - 130px)}
  .cv-wchip{background:var(--bcv-float-bg);border:1px solid var(--border-soft);border-radius:999px;color:var(--muted);
    font-size:11px;padding:2px 8px;cursor:pointer;white-space:nowrap;user-select:none}
  .cv-wchip.on{color:var(--bronze);border-color:rgba(201,143,69,.65);background:rgba(201,143,69,.14)}
  .cv-wchip:hover{border-color:var(--bronze)}
  .cv-whint{margin-left:4px;font-size:11px;color:var(--muted);white-space:nowrap}
  .cv-wall{background:var(--bcv-float-bg);border:1px solid var(--border-soft);border-radius:999px;color:var(--accent-bright,#ece1d1);
    font-size:11px;padding:2px 8px;cursor:pointer;white-space:nowrap}
  .cv-wall:hover{border-color:var(--bronze);color:var(--bronze)}
  .cv-fold{position:absolute;z-index:5;display:inline-flex;align-items:center;gap:6px;background:var(--solid);
    border:1px dashed var(--border);border-radius:999px;padding:3px 10px;font-size:11px;color:var(--muted);
    cursor:pointer;white-space:nowrap;user-select:none} /* 主题跟随:计数块底/边 rgba(24,17,10,.94)+#6b5c3a → var(--solid)/var(--border) */
  .cv-fold b{font-size:11px;color:var(--bronze)}
  .cv-fold:hover{border-color:var(--bronze);background:rgba(201,143,69,.16);color:var(--bronze)}
 /* 反向块(已展开泳道的「−N 收起」):虚线换实线 + 强调色,与 +N 一眼区分开 */
  .cv-fold[data-fold-dir="close"]{border-style:solid;border-color:rgba(201,143,69,.5);color:var(--bronze)}
  .cv-fold[data-fold-dir="close"] b{color:var(--accent-bright)}
  .cv-node .cv-foot{display:flex;align-items:center;gap:5px;padding:6px 10px 0;font-size:11px;color:var(--cv-foot-fg);flex-wrap:wrap} /* 主题跟随:卡脚元信息 #a89a7d→var(--cv-foot-fg)(默认 --muted) */
 /* ---- 白板 light 覆盖:上面主体色走主题变量后,少数「深底内联/深色板」件在浅色主题下
 仍需单独改浅(它们要么是深底线框件、要么是画布浮层),字色同步取主题深色,避免深底深字 ---- */
  body.light .cv-node{box-shadow:0 6px 18px var(--bcv-card-shadow)} /* 深色投影在纸面上糊成一坨(值走 --bcv-card-shadow) */
  body.light .cv-node.k-page{border-color:var(--bcv-wire-page-bd);background:var(--bcv-wire-page-bg);--cv-head-fg:var(--bcv-wire-title-fg);--cv-sub-fg:var(--bcv-wire-sum-fg);--cv-foot-fg:var(--bcv-wire-foot-fg)}
  body.light .cv-node.k-page .cv-head{background:var(--bcv-wire-page-head);border-bottom-color:var(--bcv-wire-page-head-bd)}
  body.light .cv-node.k-section{border-color:var(--bcv-wire-section-bd);background:var(--bcv-wire-section-bg);--cv-head-fg:var(--bcv-wire-title-fg);--cv-sub-fg:var(--bcv-wire-sum-fg);--cv-foot-fg:var(--bcv-wire-foot-fg)}
  body.light .cv-node.k-component{border-color:var(--bcv-wire-component-bd);background:var(--bcv-wire-component-bg);--cv-head-fg:var(--bcv-wire-title-fg);--cv-sub-fg:var(--bcv-wire-sum-fg);--cv-foot-fg:var(--bcv-wire-foot-fg)}
  body.light .cv-node.k-nav{border-color:var(--bcv-wire-nav-bd);background:var(--bcv-wire-nav-bg);--cv-head-fg:var(--bcv-wire-title-fg);--cv-sub-fg:var(--bcv-wire-sum-fg);--cv-foot-fg:var(--bcv-wire-foot-fg)}
  body.light .cv-node.pgbox .cv-url{color:var(--bcv-wire-foot-fg);background:var(--bcv-wire-url-bg)}
  body.light .cv-node.pgbox .cv-pgtitle{color:var(--text)}
  body.light .cv-wire{background:var(--bcv-wire-bg)}
  body.light .cv-wire .cv-wire-label{color:var(--text)}
  body.light .bf-canvas{background:radial-gradient(circle at 1px 1px, var(--bcv-grid-dot) 1px, transparent 1.4px) 0 0/22px 22px, var(--bcv-canvas-bg)}
  body.light .bf-zoombar,body.light .cv-wchip,body.light .cv-wall,body.light .cv-addpanel,body.light .bf-minimap{background:var(--bcv-float-bg)}
  body.light .bf-cv-edge-label{fill:var(--bcv-edge-label);stroke:var(--bcv-edge-label-halo)}
  .cv-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .cv-dot.linked{background:var(--bcv-edge-verify)}.cv-dot.moved{background:var(--bcv-accent-2)}.cv-dot.broken{background:var(--bcv-dot-bad)}.cv-dot.none{background:var(--bcv-wire-component-bd)}
  .cv-port{position:absolute;top:50%;width:9px;height:9px;border-radius:50%;background:var(--bcv-edge-call);border:2px solid var(--bcv-port-bd);transform:translateY(-50%)}
  .cv-port.out{right:-5px}.cv-port.in{left:-5px}
  .cv-file{cursor:pointer;color:var(--bcv-file-fg)}
  .cv-file:hover{color:var(--accent-bright);text-decoration:underline}
 /* 十期:画布直操作——端口拖拽连线/边悬停删除/右键菜单/添加模块面板/连线拖影 */
  .cv-port{cursor:crosshair}
  .cv-node.cv-connect-hint{border-color:var(--bcv-edge-verify);box-shadow:0 0 0 2px var(--bcv-code-tech-bd)}
  .bf-cv-edges .bfe-hit{stroke:transparent;stroke-width:14;fill:none;pointer-events:stroke;cursor:pointer}
  .bf-cv-edges .cv-edge-del{visibility:hidden;pointer-events:auto;cursor:pointer}
  .bf-cv-edges g.cv-edge:hover .cv-edge-del{visibility:visible}
  .bf-cv-edges .cv-edge-del circle{fill:var(--bcv-float-bg-solid);stroke:var(--bcv-dot-bad);stroke-width:1}
  .bf-cv-edges .cv-edge-del line{stroke:var(--bcv-dot-bad);stroke-width:1.4;stroke-linecap:round}
  .bf-cv-edges .bfe-connect{stroke:var(--accent-bright,#ece1d1);stroke-width:2;stroke-dasharray:6 4;fill:none}
 /* K:「添加模块/整理」原来是画布右上绝对定位浮层(压住右上角卡片,ui.light 复现)。
 改为底部占位条(.cv-rail)右端项:不再覆盖任何卡片,也不吃顶部预留高度。 */
  .cv-addbar{display:flex;gap:4px;margin-left:auto;flex:0 0 auto}
  .cv-addbar button{white-space:nowrap}
  .cv-addbar button{background:rgba(18,13,8,.92);border:1px solid var(--border-soft);color:var(--muted);font-size:11px;cursor:pointer;padding:4px 10px;border-radius:8px}
  .cv-addbar button:hover{color:var(--bronze);background:rgba(255,255,255,.05)}
 /* C 画布板头余量:板名 meta 原先内联 white-space:nowrap → 窄卡片(面板卡片可缩到 320px)
 会横穿右上工具栏。改为可换行 + 右侧给「添加/整理」留位;行数上限 2 行防压住下方写者 chip 条。 */
  .bd-meta-canvas{position:absolute;left:10px;top:8px;margin-top:0;max-width:calc(100% - 150px);white-space:normal;overflow-wrap:anywhere;
    line-height:1.45;max-height:2.9em;overflow:hidden;pointer-events:none}
 /* B:research 板决策矩阵视图(候选 × 维度) */
  .cv-matrix-btn{position:absolute;right:10px;top:36px;z-index:8;background:rgba(18,13,8,.92);border:1px solid var(--border-soft);
    color:var(--bronze);font-size:11px;cursor:pointer;padding:4px 10px;border-radius:8px}
  .cv-matrix-btn:hover{color:var(--accent-bright);border-color:var(--bronze)}
  .bd-matrix-host{display:flex;flex-direction:column;overflow:hidden}
  .bd-matrix-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--border-soft);flex-shrink:0}
  .bd-matrix-bar .vw-act{margin-left:0}
  .bd-matrix-title{font-size:12px;color:var(--bronze);letter-spacing:1px}
  .bd-matrix-sub{font-size:10px;color:var(--faint)}
  .bd-mx-sel{flex-shrink:0;padding:6px 10px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border-soft);
    overflow-wrap:anywhere;max-height:92px;overflow:auto}
  .bd-mx-sel b{color:var(--text)}
  .bd-mx-scroll{flex:1;min-height:0;overflow:auto;padding:8px}
  .bd-matrix{border-collapse:collapse;min-width:680px;width:100%}
  .bd-matrix th,.bd-matrix td{border:1px solid var(--border-soft);padding:6px 8px;text-align:left;vertical-align:top;
    font-size:11px;line-height:1.55;overflow-wrap:anywhere}
  .bd-matrix thead th{position:sticky;top:0;z-index:1;background:var(--solid);color:var(--bronze);font-weight:600}
  .bd-matrix th:first-child,.bd-matrix td:first-child{width:170px}
  .bd-matrix tbody tr.on td{background:rgba(201,143,69,.10)}
  .bd-mx-cand{cursor:pointer}
  .bd-mx-cand:hover{background:var(--hover-bg)}
  .bd-mx-name{color:var(--text);font-weight:600}
  .bd-mx-sum{font-size:10px;color:var(--faint);margin-top:3px}
  .bd-mx-meta{font-size:11px;color:var(--bronze);margin-top:4px}
  .bd-mx-cell{cursor:pointer;color:var(--text)}
  .bd-mx-cell.empty{color:var(--faint);text-align:center}
  .bd-mx-cell.unknown{color:var(--warn,#d9b36c);border-style:dashed}
  .bd-mx-weight{display:inline-block;margin-left:4px;font-size:11px;color:var(--bronze);border:1px solid var(--border-soft);border-radius:4px;padding:0 3px}
  .bd-mx-conf{display:inline-block;margin-left:5px;font-size:11px;border-radius:4px;padding:0 3px;border:1px solid}
  .bd-mx-conf.c-高{color:#a9e6db;border-color:rgba(95,194,176,.45)}
  .bd-mx-conf.c-中{color:#f6c9a0;border-color:rgba(240,161,94,.45)}
  .bd-mx-conf.c-低{color:#f7b6c0;border-color:rgba(242,124,141,.45)}
  .bd-mx-cell:hover{background:var(--hover-bg)}
  .bd-mx-cell.on{outline:1px solid var(--bronze);outline-offset:-1px;background:rgba(201,143,69,.12)}
  .bd-mx-src{display:inline-block;margin-left:5px;font-size:11px;color:var(--faint);border:1px solid var(--border-soft);
    border-radius:5px;padding:0 4px;vertical-align:1px}
  .bd-mx-concl,.bd-mx-note,.bd-mx-hint{margin:8px 10px 0;font-size:11px;line-height:1.6;color:var(--muted);
    border-left:2px solid var(--bronze);padding-left:8px;overflow-wrap:anywhere}
  .bd-mx-note{color:var(--faint)}
  .bd-mx-hint{color:var(--warn,#d9b36c);border-left-color:var(--warn,#d9b36c)}
  .bd-mx-empty{margin:auto;padding:20px;max-width:560px;font-size:12px;color:var(--muted);line-height:1.7;text-align:center}
 /* C 画布浮层(板名 meta / 写者 chip / 添加工具条)按画布自身宽度让位:
 窄卡片下 meta 换行不再横穿工具条,chip 条下移,图例收窄——三者都保持可点区域不被糊住。 */
  .bf-canvas{container-type:inline-size}
  @container (max-width:760px){
 /* 窄卡片:仍给右上工具条留 150px(否则板名横穿「添加/整理」);两行封顶,写者 chip 条已下移到 44px */
    .bd-meta-canvas{max-width:calc(100% - 150px);max-height:2.9em;left:8px;right:auto}
    .cv-wbar{top:44px;left:8px;max-width:calc(100% - 16px)}
 /* K:工具条已移到底部占位条(静态 flex 项),不再有 right/top 定位可改,只收按钮内距 */
    .cv-addbar button{padding:3px 7px;font-size:10px}
    .cv-matrix-btn{right:8px;top:34px;padding:3px 8px;font-size:10px}
    .cv-legend{max-width:100%;gap:8px;font-size:11px;padding:3px 8px}
  }
  .cv-addpanel{position:absolute;right:10px;top:36px;width:212px;max-height:308px;overflow-y:auto;z-index:9;
    background:rgba(18,13,8,.97);border:1px solid var(--border-soft);border-radius:10px;padding:8px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
  .cv-addpanel input{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border-soft);color:var(--text);border-radius:8px;padding:4px 8px;font-size:11px;margin-bottom:4px}
  .cv-addpanel .cv-agrp{font-size:11px;color:var(--faint);letter-spacing:1px;margin:6px 0 2px}
  .cv-addpanel .cv-aitem{display:flex;align-items:center;gap:7px;padding:4px 6px;border-radius:7px;cursor:pointer;font-size:11px;color:var(--text)}
  .cv-addpanel .cv-aitem:hover{background:rgba(201,143,69,.12)}
  .cv-ctx{position:absolute;z-index:10;min-width:132px;background:rgba(18,13,8,.97);border:1px solid var(--border-soft);border-radius:10px;padding:4px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
  .cv-ctx button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);font-size:11px;padding:6px 10px;border-radius:7px;cursor:pointer;white-space:nowrap}
  .cv-ctx button:hover{background:rgba(201,143,69,.12)}
  .cv-ctx button:disabled{color:var(--faint);cursor:default}
  .cv-ctx button:disabled:hover{background:none}
  #mentionMenu{position:absolute;bottom:100%;left:34px;right:28px;max-height:260px;overflow-y:auto;
    background:var(--window-bg,#141009);border:1px solid var(--border);border-radius:12px;
    box-shadow:0 12px 40px rgba(0,0,0,.55);padding:6px;z-index:61}
  #mentionMenu .sc-item .sc-name{color:var(--green)}
  #slashMenu{position:absolute;bottom:100%;left:34px;right:28px;max-height:300px;overflow-y:auto;
    background:var(--window-bg,#141009);border:1px solid var(--border);border-radius:12px;
    box-shadow:0 12px 40px rgba(0,0,0,.55);padding:6px;z-index:60}
  .sc-item{display:flex;align-items:baseline;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer}
  .sc-item.hot,.sc-item:hover{background:var(--accent-soft)}
  .sc-item .sc-name{font-family:var(--mono);font-size:12px;color:var(--bronze);flex-shrink:0}
  .sc-item .sc-desc{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sc-item .sc-hint{color:var(--faint);font-size:10px}
  .sc-item .sc-kind{margin-left:auto;font-size:9px;color:var(--faint);letter-spacing:1px;flex-shrink:0}
  .sc-empty{padding:10px;font-size:11px;color:var(--faint);text-align:center}
  .sc-group{padding:6px 10px 2px;font-size:9px;color:var(--faint);letter-spacing:1px}
  .sc-group:first-child{padding-top:2px}
  .sc-item.sc-newcmd{margin-top:4px;border-top:1px solid var(--border-soft);border-radius:0;color:var(--muted)}
  .sc-item.sc-newcmd .sc-name{color:var(--muted);font-size:11px}
  .hint{font-size:9px;color:var(--faint);margin-top:5px;letter-spacing:1px}

 /* ---- 响应式(/055:聊天窗按窗口尺寸自由伸缩)----
 * 原则:连续 fluid(clamp)优先,断点只做离散档位;右侧停靠(Super Agent 指挥台)由 #superConsole 自身定位。 */
  @media (max-width:1600px){
    .chat-col{padding-right:10px}
    footer{padding-right:20px}
  }
  @media (max-width:1400px){
    :root{--sbw:220px}
    .hint{font-size:0;letter-spacing:0} /* 文字让位,计时 chip 保留 */
    .hint #workTimer{font-size:9px}
    .view-name{display:none}
    .brand-sub{display:none}
  }
  @media (max-width:1150px){
    .chat-col{padding-left:14px}
    footer{padding-left:14px}
    .mode-pill{font-size:9.5px;padding:1px 7px}
    .model-trigger{max-width:180px}
    .model-trigger .mt-provider{display:none} /* u7 收窄第一步:先收 provider 前缀,模型名优先保留 */
  }
 /* u7 更窄:zcode 口径=依次收起各处文字→隐藏 provider 前缀→模型选择器变纯图标方形按钮(size-7);
 档位按钮同样只留脑图标+进度条 */
  @media (max-width:980px){
    .model-trigger .mt-label{display:none}
    .model-trigger{width:28px;max-width:28px;padding:0;justify-content:center;gap:0}
    .thought-btn .tb-text{display:none}
    .thought-btn{padding:0 4px}
  }
  @media (max-width:860px){
    :root{--sbw:64px}
 /* 图标条模式(用户参照的成熟软件行为:装不下→省略文字只留图标);font-size:0 压掉裸文本标签,svg 不受影响 */
    .sb-acts .sb-act{justify-content:center;gap:0;font-size:0;padding:9px 6px}
    .sb-acts .sb-kbd{display:none}
 /* 侧栏顶部三入口同样只留图标(随侧栏塌折,不额外做悬浮) */
    .sb-nav .sb-act{justify-content:center;gap:0;font-size:0;padding:9px 6px}
    .sb-nav .sb-kbd{display:none}
    #sidebar .bn,#sidebar .bs{display:none}
    .sb-brand{justify-content:center;padding:14px 6px 10px}
    .sb-tt{font-size:0;padding:3px 6px}
  }
 /* ===================== 图标/素描 emoji 基座 + 主题质感层 ===================== */
 /* 线性图标基座:stroke=currentColor 跟文字色走(七主题自适配),描边粗细 --ic-sw 变量 */
  .icn{width:1em;height:1em;stroke:currentColor;fill:none;stroke-width:var(--ic-sw,1.7);stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;vertical-align:-0.13em;display:inline-block}
  button .icn{width:1.08em;height:1.08em;vertical-align:-0.16em}
  .icn.ok{color:var(--green)}
  .icn.bad{color:var(--red)}
  .icn.mut{color:var(--faint)}
  .icn.acc{color:var(--accent)}
  @keyframes icnSpin{to{transform:rotate(360deg)}}
  .icn.run{animation:icnSpin 1.6s linear infinite}
 /* 内容层素描 emoji:映射命中=主题风格线描;未命中=去彩滤镜包裹(语义 title 保留) */
  .emj{display:inline-block;width:1.18em;height:1.18em;vertical-align:-0.18em}
  .emj-sk{stroke:currentColor;fill:none;stroke-width:var(--ic-sw,1.7);stroke-linecap:round;stroke-linejoin:round}
  .emj-rw{filter:grayscale(1) sepia(.3) saturate(1.25) brightness(1.02);opacity:.9;font-style:normal}
 /* 空态图标:mask 单色描形,跟随文字色(全部 cc-empty 站点一次覆盖) */
  .cc-empty::before{content:'';display:inline-block;width:14px;height:14px;margin-right:6px;vertical-align:-2px;opacity:.55;background:currentColor;
    -webkit-mask:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M4.5 13.5l2-7h11l2 7v5a1.5 1.5 0 0 1-1.5 1.5h-12a1.5 1.5 0 0 1-1.5-1.5z' fill='none' stroke='black' stroke-width='1.7' stroke-linejoin='round'/><path d='M4.5 13.5H9a3 3 0 0 0 6 0h4.5' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round'/></svg>") center/contain no-repeat;
    mask:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M4.5 13.5l2-7h11l2 7v5a1.5 1.5 0 0 1-1.5 1.5h-12a1.5 1.5 0 0 1-1.5-1.5z' fill='none' stroke='black' stroke-width='1.7' stroke-linejoin='round'/><path d='M4.5 13.5H9a3 3 0 0 0 6 0h4.5' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round'/></svg>") center/contain no-repeat}
 /* 位点级尺寸/节奏收敛 */
  .empty-line .icn{width:14px;height:14px;vertical-align:-2px;opacity:.7}
 /* 新用户经验证:首启空会话只有「该会话暂无记录」,缺模型/项目时无路可走。
 引导卡只在缺失项存在时出现,点到即直达(接入模型=设置页模型区;添加项目=目录浏览器)。 */
  .first-run-card{max-width:480px;margin:20px auto;border:1px solid var(--border-soft);border-radius:12px;background:var(--glass);padding:16px 18px;text-align:left;font-family:var(--font-body)}
  .first-run-card .fr-title{font-size:14px;color:var(--text);font-weight:600;letter-spacing:.5px}
  .first-run-card .fr-sub{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.6}
  .first-run-card .fr-steps{display:flex;flex-direction:column;gap:8px;margin-top:12px}
  .first-run-card .fr-step{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--text);background:transparent;border:1px solid var(--border-soft);border-radius:8px;padding:9px 11px;cursor:pointer;text-align:left;width:100%}
  .first-run-card .fr-step:hover{border-color:var(--bronze);background:var(--hover-bg)}
  .first-run-card .fr-step[disabled]{color:var(--faint);cursor:default;border-style:dashed}
  .first-run-card .fr-step[disabled]:hover{border-color:var(--border-soft);background:transparent}
  .first-run-card .fr-step b{color:var(--accent-bright);font-weight:600;min-width:16px}
  .first-run-card .fr-done{margin-left:auto;color:var(--green);font-size:11.5px}
  .pm-ck .icn{width:12px;height:12px;vertical-align:-1.5px}
  .bh-chev .icn{width:9px;height:9px}
  .bh-files .icn{width:11px;height:11px;vertical-align:-1px}
  .ft-row .chev .icn{width:8px;height:8px}
  .ft-row .ic .icn,.db-row .ic .icn{width:13px;height:13px;vertical-align:-2px;opacity:.85}
  .task-sub .icn{width:11px;height:11px;vertical-align:-1px;opacity:.9}
  .st-chip .icn{width:10px;height:10px;vertical-align:-1px}
  .sys-line .icn.ok{color:var(--green);width:11px;height:11px;vertical-align:-1px}
  .sub-tail .icn,.office-chip .icn{width:11px;height:11px;vertical-align:-1px}
  .pi-x .icn,.ac-x .icn{width:11px;height:11px;vertical-align:-1.5px;opacity:.7}
  .pi-x:hover .icn,.ac-x:hover .icn{opacity:1;color:var(--red)}
  .rev-inj .icn,.rev-inj-all .icn{width:11px;height:11px;vertical-align:-1px}
  .rev-sev .icn{width:10px;height:10px;vertical-align:-1px}
  .ti .icn{width:12px;height:12px;vertical-align:-2px}
  .bf-done .icn{width:12px;height:12px;vertical-align:-1.5px;color:var(--green)}
  .bd-tag .icn{width:10px;height:10px;vertical-align:-1px}
 /* 主题质感层:图标跟主题走(ink 加粗纯形/glass 半透/浅色主题不加辉光) */
  body.theme-ink .icn,body.theme-ink .emj-sk{stroke-width:2.1;filter:none}
  body.theme-ink .emj-rw{filter:grayscale(1) contrast(1.08);opacity:.82}
  body.theme-glass .icn{opacity:.92}
  body.theme-glass .emj-rw{filter:grayscale(1) brightness(1.3);opacity:.88}
  body.light .icn{stroke-width:1.8}
  body.light .emj-rw{filter:grayscale(1) contrast(.9) sepia(.15);opacity:.85}

 /* ===== 动效体系(变量层见 :root/--anim-*;七主题取值见各 theme 块) =====
 * 红线:transform/opacity 为主;循环装饰按主题气质选择性挂载;ink 全量静态;
 * 视图/面板入场走 display 切换的 animation 重启机制(零 JS);reduced-motion 统一降级见尾部。 */

 /* ---  输入类基线过渡补全(与 button 基座同节奏:focus 边框/辉光渐变,ink 即时) --- */
  input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),textarea{
    transition:border-color var(--anim-dur-fast) var(--anim-ease),box-shadow var(--anim-dur-fast) var(--anim-ease)}

 /* --- / 视图与 tab 面板入场(淡入+微位移;位移量=--view-shift,ink=0) --- */
  .view.on{animation:viewIn var(--anim-dur-base) var(--anim-ease)}
  .pp-tabpane.on{animation:viewIn var(--anim-dur-base) var(--anim-ease)}
  @keyframes viewIn{from{opacity:0;transform:translateY(var(--view-shift,6px))}to{opacity:1;transform:none}}

 /* ---  新消息入场(mfPatch 追加路径的新根挂 .msg-in;全量重建/替换区不加防闪烁) --- */
  .msg-in{animation:viewIn var(--anim-dur-base) var(--anim-ease)}

 /* ---  工具卡展开内容浮现(收起走 native;transform 不受自身 overflow 影响) --- */
  .tool-card[open] .tc-body{animation:tcReveal var(--anim-dur-fast) var(--anim-ease)}
  @keyframes tcReveal{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

 /* ---  思考卡呼吸态(流式生成中;伪元素 opacity 循环=合成层,不动布局) --- */
  .think-card.think-live{position:relative}
  .think-card.think-live::after{content:'';position:absolute;inset:-1px;border-radius:9px;pointer-events:none;
    border:1px solid var(--bronze);box-shadow:0 0 14px var(--bronze-glow);opacity:0;
    animation:thinkBreath 2.2s ease-in-out infinite}
  @keyframes thinkBreath{0%,100%{opacity:0}50%{opacity:.45}}

 /* --- // 任务状态点:running=转圈(既有 tSpin)+辉光呼吸;done=✓ 弹入一次;failed=轻晃一次 --- */
  .t-dot.running{animation:tSpin .8s linear infinite,dotGlow 1.6s ease-in-out infinite}
  @keyframes dotGlow{0%,100%{box-shadow:0 0 0 transparent}50%{box-shadow:0 0 7px var(--bronze-glow)}}
  .t-dot.done{animation:popIn var(--anim-dur-slow) var(--anim-ease-spring) both}
  @keyframes popIn{from{transform:scale(.2);opacity:0}60%{transform:scale(1.3);opacity:1}to{transform:scale(1);opacity:1}}
  .t-dot.failed{animation:shakeX 300ms var(--anim-ease)}
  @keyframes shakeX{0%,100%{transform:none}25%{transform:translateX(-2px)}75%{transform:translateX(2px)}}
  body.theme-ink .t-dot.running{animation:tSpin .8s linear infinite} /* ink:保留功能性转圈,去装饰 */
  body.theme-ink .t-dot.done,body.theme-ink .t-dot.failed{animation:none}

 /* ---  白板节点拖拽提升态(scale+深影;left/top 不入 transition 列=拖拽跟手不受影响) --- */
  .cv-node.dragging{cursor:grabbing;z-index:5;transform:scale(1.03);
    box-shadow:0 14px 36px rgba(0,0,0,.5),0 0 0 1px var(--accent-soft);
    transition:transform var(--anim-dur-fast) var(--anim-ease),box-shadow var(--anim-dur-fast) var(--anim-ease)}

 /* ---  连线绘制中的流动虚线(SVG stroke 例外:单临时元素,paint 面积极小) --- */
  .bf-cv-edges .bfe-connect{animation:dashFlow .9s linear infinite}
  @keyframes dashFlow{to{stroke-dashoffset:-20}}
  body.theme-ink .bf-cv-edges .bfe-connect{animation:none}

 /* ---  主线金框微光呼吸( pgmain;仅暗色/glass,浅色主题静态) --- */
  .cv-node.pgbox.pgmain{position:relative}
  .cv-node.pgbox.pgmain::after{content:'';position:absolute;inset:-3px;border-radius:12px;pointer-events:none;
    border:2px solid rgba(224,180,106,.5);box-shadow:0 0 18px rgba(224,180,106,.3);opacity:0}
  body:not(.light):not(.theme-glass):not(.theme-ink) .cv-node.pgbox.pgmain::after{
    animation:mainGlow 2.6s ease-in-out infinite}
  @keyframes mainGlow{0%,100%{opacity:0}50%{opacity:.6}}

 /* ---  主题切换全页色彩过渡(JS 在主题类真变化时挂 body.theme-fade 320ms;变量变化经 transition 平滑) --- */
  body.theme-fade,body.theme-fade *,body.theme-fade *::before,body.theme-fade *::after,body.theme-fade::before,body.theme-fade::after{
    transition:background-color .24s ease,color .24s ease,border-color .24s ease,box-shadow .24s ease,
               fill .24s ease,stroke .24s ease,background-position 0s ease !important}

 /* ---  空态入场+图标微浮动(幅度走 --anim-decor:ink/light=0) --- */
  .cc-empty{animation:viewIn var(--anim-dur-base) var(--anim-ease)}
  .cc-empty::before{animation:emptyFloat 6s ease-in-out infinite}
  @keyframes emptyFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(calc(-2.5px * var(--anim-decor,1)))}}
  body.theme-ink .cc-empty::before,body.light .cc-empty::before{animation:none}

 /* ---  初始加载骨架点(cc-empty.loading:HTML 模板初始占位挂类;整组 opacity 呼吸,合规) --- */
  .cc-empty.loading::after{content:' · · ·';display:inline-block;margin-left:2px;color:var(--faint);
    animation:dotsBlink 1.2s ease-in-out infinite}
  @keyframes dotsBlink{0%,100%{opacity:.15}50%{opacity:.9}}

 /* ---  主题特征循环装饰 ---
 * dark:品牌点辉光呼吸(伪元素 opacity);light/glass/ink 关。 */
  .brand-dot{position:relative}
  .brand-dot::after{content:'';position:absolute;inset:-3px;border-radius:50%;pointer-events:none;opacity:0;
    box-shadow:0 0 12px var(--bronze-glow);animation:decorGlow 3.2s ease-in-out infinite}
  body.light .brand-dot::after,body.theme-ink .brand-dot::after,
  body.theme-glass .brand-dot::after{animation:none}
  @keyframes decorGlow{0%,100%{opacity:0}50%{opacity:.55}}

 /* ---  全局可访问性降级(088 glass 先例的泛化:一次性动画立即完成,循环动画停首帧) --- */
  @media (prefers-reduced-motion:reduce){
 *,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;
      transition-duration:.01ms !important;transition-delay:0ms !important}
  }

 /* --- 截图标注:取屏画框覆盖层 + 标注编辑器 --- */
  #capOverlay{position:fixed;inset:0;z-index:100000;background:rgba(8,5,3,.72);display:flex;align-items:center;justify-content:center;cursor:crosshair}
 /* 显式吃满覆盖层:位图按 dpr 放大,尺寸换算由脚本归一;缺席时 flex 会把 canvas 等比压缩→rect≠位图=取屏偏移源 */
  #capCanvas{display:block;width:100%;height:100%;box-shadow:0 8px 40px rgba(0,0,0,.55)}
  #capSel{position:fixed;border:1.5px solid var(--bronze,#c98f45);box-shadow:0 0 0 200000px rgba(0,0,0,.5);pointer-events:none}
  #capSize{position:fixed;background:rgba(10,6,4,.9);color:var(--text,#ece1d1);font-size:11px;padding:2px 7px;border-radius:6px;pointer-events:none;border:1px solid var(--border-soft,rgba(255,255,255,.12))}
  #capBar{position:fixed;display:flex;gap:8px;background:rgba(12,8,5,.96);border:1px solid var(--border-soft,rgba(255,255,255,.12));border-radius:10px;padding:8px}
  #capBar button{border:1px solid var(--border-soft,rgba(255,255,255,.12));background:transparent;color:var(--text,#ece1d1);border-radius:8px;padding:5px 14px;font-size:12px;cursor:pointer}
  #capBar button:hover{border-color:var(--bronze,#c98f45)}
  #capOk{background:var(--bronze,#c98f45) !important;color:#171008 !important;font-weight:600}
  #capHint{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:rgba(12,8,5,.92);border:1px solid var(--border-soft,rgba(255,255,255,.12));color:var(--muted,#b9a98f);font-size:12px;padding:6px 14px;border-radius:999px;pointer-events:none}
  #annEditor{position:fixed;inset:0;z-index:100001;background:var(--bg,#0b0806);display:flex;flex-direction:column}
  #annTop{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border-soft,rgba(255,255,255,.1));flex-shrink:0}
  #annTop strong{font-size:14px;color:var(--text,#ece1d1)}
  #annMeta{font-size:11px;color:var(--faint,#8d7f6a)}
  #annPage{width:210px;background:var(--input-bg,rgba(255,255,255,.04));border:1px solid var(--border-soft,rgba(255,255,255,.12));border-radius:8px;color:var(--text,#ece1d1);font-size:12px;padding:5px 9px}
  #annPage:focus{border-color:var(--bronze,#c98f45);outline:none}
  #annPage::placeholder{color:var(--faint,#8d7f6a)}
  #annCoords{font-size:11px;color:var(--muted,#b9a98f);min-width:86px}
  .ann-sp{flex:1}
  .ann-tbtn{border:1px solid var(--border-soft,rgba(255,255,255,.12));background:transparent;color:var(--text,#ece1d1);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}
  #annRecState{font-size:11px;color:var(--muted,#b9a98f);min-width:0;white-space:nowrap}
  #annRecState.rec{color:#e2564a;font-weight:600}
  #annRecAudio{width:190px;height:26px;vertical-align:middle}
  .ann-tbtn:hover{border-color:var(--bronze,#c98f45)}
  .ann-tbtn:disabled{opacity:.4;cursor:default}
  #annZoomLabel{font-size:11px;color:var(--muted,#b9a98f);min-width:38px;text-align:center}
  #annSend{border:0;background:var(--bronze,#c98f45);color:#171008;font-weight:600;border-radius:8px;padding:6px 18px;font-size:13px;cursor:pointer}
  #annSend:disabled{opacity:.5;cursor:default}
  #annMain{flex:1;display:flex;min-height:0}
  #annViewport{flex:1;position:relative;overflow:hidden;background:#0e0a07;cursor:default}
  #annStage{position:absolute;transform-origin:0 0}
 /* canvas 是替换元素:position:absolute+inset:0 且 width:auto 时按固有尺寸(图像 px)排布,不随 stage 缩放,
 只会露出原图左上角一块。显式 100% 让它跟着 stage 的 w*zoom 一起缩放(2026-11-12 修复)。 */
  #annCanvas{display:block;position:absolute;left:0;top:0;width:100%;height:100%}
  #annOverlay{position:absolute;inset:0;width:100%;height:100%;display:block}
  #annPins{position:absolute;inset:0;pointer-events:none}
  .ann-pin{position:absolute;transform:translate(-50%,-50%);min-width:20px;height:20px;border-radius:999px;border:1.5px solid #fff;background:var(--bronze,#c98f45);color:#171008;font-size:11px;font-weight:700;cursor:pointer;pointer-events:auto;padding:0 5px;line-height:17px;text-align:center}
  .ann-pin.selected{background:#fff;border-color:var(--bronze,#c98f45)}
  #annSide{width:300px;flex-shrink:0;border-left:1px solid var(--border-soft,rgba(255,255,255,.1));display:flex;flex-direction:column;min-height:0}
  #annTools{display:flex;gap:6px;padding:10px 12px 6px}
  .ann-tool{flex:1;border:1px solid var(--border-soft,rgba(255,255,255,.12));background:transparent;color:var(--text,#ece1d1);border-radius:8px;padding:5px 0;font-size:12px;cursor:pointer}
  .ann-tool.active{border-color:var(--bronze,#c98f45);color:var(--bronze,#c98f45);font-weight:600}
  #annHint{font-size:11px;color:var(--faint,#8d7f6a);padding:0 12px 8px}
 /* 录屏批注覆盖层:屏幕合成画面 + 浮动工具条 */
  #annvOverlay{position:fixed;inset:0;z-index:100002;background:#000;flex-direction:column;align-items:center;justify-content:center;gap:10px}
  #annvCanvas{display:block;max-width:96vw;max-height:calc(100vh - 92px);background:#000;cursor:crosshair;box-shadow:0 10px 50px rgba(0,0,0,.7);touch-action:none}
  #annvBar{display:flex;align-items:center;gap:8px;background:rgba(12,8,5,.96);border:1px solid var(--border-soft,rgba(255,255,255,.14));border-radius:999px;padding:7px 14px;max-width:96vw;flex-wrap:wrap;justify-content:center}
  #annvTimer{font-size:12px;color:#e2564a;font-weight:600;font-variant-numeric:tabular-nums}
  #annvHint{font-size:11px;color:var(--faint,#8d7f6a);max-width:520px}
  #annvBar .ann-tbtn.on{border-color:var(--bronze,#c98f45);color:var(--bronze,#c98f45);font-weight:600}
  #annvStop{background:var(--bronze,#c98f45);color:#171008;border-color:transparent;font-weight:600}
  #annVidState{font-size:11px;color:var(--muted,#b9a98f);white-space:nowrap}
  #annVidPreview{vertical-align:middle;border-radius:6px;background:#000}
  #annInline{position:absolute;z-index:30;width:250px;background:var(--input-bg,rgba(20,14,8,.97));border:1.5px solid var(--bronze,#c98f45);border-radius:10px;padding:8px;box-shadow:0 6px 24px rgba(0,0,0,.5)}
  #annInline textarea{width:100%;box-sizing:border-box;background:transparent;border:0;color:var(--text,#ece1d1);font-size:12px;line-height:1.5;resize:none;outline:none;min-height:36px}
  #annInline textarea::placeholder{color:var(--faint,#8d7f6a)}
  .ann-inline-bar{display:flex;align-items:center;justify-content:space-between;margin-top:4px}
  .ann-inline-bar span{font-size:10px;color:var(--faint,#8d7f6a)}
  .ann-inline-bar button{border:0;background:var(--bronze,#c98f45);color:#171008;font-weight:600;border-radius:6px;padding:3px 12px;font-size:11px;cursor:pointer}
  #annCoords{font-size:11px;color:var(--muted,#b9a98f);min-width:86px}
  .ann-card{border:1px solid var(--border-soft,rgba(255,255,255,.12));border-radius:10px;padding:8px 10px;background:var(--input-bg,rgba(255,255,255,.04))}
  .ann-card.selected{border-color:var(--bronze,#c98f45)}
  .ann-card-head{display:flex;align-items:center;gap:6px;margin-bottom:5px}
  .ann-card-num{min-width:18px;height:18px;border-radius:999px;background:var(--bronze,#c98f45);color:#171008;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;padding:0 4px}
  .ann-card-kind{font-size:11px;color:var(--muted,#b9a98f)}
  .ann-card-pos{font-size:10px;color:var(--faint,#8d7f6a);margin-left:auto}
  .ann-card-del{border:0;background:transparent;color:var(--faint,#8d7f6a);cursor:pointer;font-size:12px;padding:0 2px}
  .ann-card-del:hover{color:#e06c5a}
  .ann-card textarea{width:100%;box-sizing:border-box;background:transparent;border:0;color:var(--text,#ece1d1);font-size:12px;line-height:1.5;resize:vertical;min-height:38px;outline:none}
  .ann-card textarea::placeholder{color:var(--faint,#8d7f6a)}
  #annEmpty{color:var(--faint,#8d7f6a);font-size:12px;text-align:center;padding:26px 0}
 /* ── →1545:Super Agent 指挥台 view(IDE 三栏);看板四区 DOM 保留但隐藏(P1 收编)。── */
  #view-super{flex-direction:column;position:relative}
 /* 聊天窗是右缘叠层(top:0 起):视图头也给它让位,避免「刷新/作用域」压在聊天头部下面 */
  #view-super .vw-head{padding-right:var(--superChatW,360px)}
  #superChatBody{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
 /* 与 coding agent 主聊天同款 composer( Super 聊天窗也要和 coding agent 一样) */
  #superComposer{flex:0 0 auto;padding:8px 9px 6px;border-top:1px solid var(--border-soft,rgba(201,143,69,.18));display:flex;flex-direction:column;gap:2px}
  #superComposer .composer{margin-top:0}
  #superComposer .composer textarea{width:100%;border:0;background:transparent;color:var(--text);font-family:var(--sans);font-size:13px;line-height:1.5;min-height:24px;max-height:160px;resize:none;outline:none;padding:4px 2px 2px;box-sizing:border-box}
  #superComposer .composer textarea::placeholder{color:var(--faint)}
  #superInput:focus{outline:none}
  #superInput:disabled{opacity:.55}
  #superSend{flex:0 0 auto}
  #superChatBody .sys-line{color:var(--muted,#97836a)} /* 系统行用 muted:浅色主题下 bronze 字对比度仅 ~2:1 */
 /* 快捷指令菜单(替代主聊天的附件 + 菜单;Super 的 + = 三个常用指令) */
  .sup-quick-menu{position:absolute;bottom:calc(100% + 6px);left:8px;z-index:20;background:var(--solid,#141009);border:1px solid var(--border,rgba(200,143,69,.28));border-radius:10px;box-shadow:0 10px 30px var(--overlay,rgba(0,0,0,.55));padding:5px;display:flex;flex-direction:column;gap:2px;min-width:156px}
  .sup-quick-menu button{border:0;background:transparent;color:var(--text);text-align:left;font:inherit;font-size:11.5px;padding:5px 9px;border-radius:6px;cursor:pointer}
  .sup-quick-menu button:hover{background:var(--hover-bg,rgba(255,255,255,.06))}
  .sup-day{align-self:center;font-family:var(--mono,ui-monospace,monospace);font-size:10px;color:var(--faint,#7d6c58);border:1px dashed var(--border-soft,rgba(201,143,69,.2));border-radius:999px;padding:1px 10px}
 /* 消息角色层:身份/时间在气泡上方,正文在气泡里——Super 与「你」一眼可辨 */
  #superChatBody .sup-msg{display:flex;flex-direction:column;gap:4px;min-width:0}
  #superChatBody .sup-msg.u{align-items:flex-end}
  .sup-msg-h{display:flex;align-items:center;gap:6px;font-size:9.5px;color:var(--faint);padding:0 2px;min-width:0}
  .sup-msg.u .sup-msg-h{flex-direction:row-reverse}
  .sup-msg .sup-ava{width:16px;height:16px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:700;color:var(--on-accent,#1c1108);background:var(--bronze,#c98f45);flex:0 0 auto}
  .sup-msg .sup-who{font-size:10px;color:var(--muted);letter-spacing:.4px}
  .sup-msg.u .sup-who{color:var(--bronze,#c98f45)}
  .sup-msg .sup-time{font-family:var(--mono,ui-monospace,monospace);font-size:9px;color:var(--muted)}
  .sup-msg-body{display:flex;flex-direction:column;gap:6px;min-width:0;width:100%}
  .sup-msg.u .sup-msg-body{align-items:flex-end}
  .sup-msg .user-line{margin:0;width:auto;max-width:100%}
  .sup-msg.sys,.sup-msg.relay{align-items:stretch}
  .sup-msg.sys .sys-line,.sup-msg.sys .sup-bub,.sup-msg.relay .sup-bub{width:100%;max-width:100%}
  .sup-tools-h{display:flex;align-items:center;gap:6px;font-size:9.5px;letter-spacing:.6px;color:var(--faint);margin:2px 0 -1px}
  .sup-tools-h::after{content:"";flex:1 1 auto;height:1px;background:var(--border-soft)}
  .sup-quick{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
  .sup-quick button{border:1px solid var(--border-soft,rgba(201,143,69,.3));background:var(--input-bg);color:var(--muted);border-radius:999px;padding:3px 11px;font-size:10.5px;cursor:pointer}
  .sup-quick button:hover{border-color:var(--bronze);color:var(--text)}
 /* Super→Coding Agent 派发关系条(聊天里只报「已派给谁」,结果仍在中栏) */
  .sup-rel{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border:1px solid var(--border-soft,rgba(201,143,69,.26));border-radius:8px;padding:5px 8px;background:var(--surf-card,rgba(0,0,0,.14));font-size:10.5px;color:var(--muted);cursor:pointer;min-width:0}
  .sup-rel:hover{border-color:var(--bronze,#c98f45);background:var(--hover-bg,rgba(255,255,255,.05))}
  .sup-rel .sup-rel-node{color:var(--text);font-weight:600;white-space:nowrap}
  .sup-rel .sup-rel-arrow{color:var(--bronze,#c98f45);font-weight:600}
  .sup-rel .sup-rel-id{font-family:var(--mono,ui-monospace,monospace);font-size:9.5px;color:var(--faint)}
  .sup-rel .sup-rel-note{margin-left:auto;color:var(--faint);font-size:9.5px;white-space:nowrap}
  .sup-bub{max-width:86%;padding:7px 10px;border-radius:10px;line-height:1.6;word-break:break-word;white-space:pre-wrap;font-size:12.5px}
  .sup-bub.u{align-self:flex-end;background:var(--bubble-a,rgba(201,143,69,.16));border:1px solid var(--border-soft,rgba(201,143,69,.26))}
  .sup-bub.a{align-self:flex-start;background:var(--surf-card,rgba(255,255,255,.035));border:1px solid var(--border-soft,rgba(201,143,69,.16))}
  .sup-bub.sys{align-self:center;max-width:94%;background:transparent;border:1px dashed var(--border-soft,rgba(201,143,69,.22));color:var(--muted,#a08e78);font-size:11.5px}
 /* 长系统通知折叠:超 160 字默认 3 行,点击整行展开/收起(对话流优先,不让通知刷屏) */
  #superChatBody .sys-line.sys-long{max-height:76px;overflow:hidden;cursor:pointer}
  #superChatBody .sys-line.sys-long.exp{max-height:none;cursor:zoom-out}
  #superChatBody .sys-line.sys-long::after{content:"展开";margin-left:auto;flex:0 0 auto;font-size:10px;color:var(--bronze,#c98f45);opacity:.75}
  #superChatBody .sys-line.sys-long.exp::after{content:"收起"}
  .sup-bub .sup-t{display:block;font-family:var(--mono,ui-monospace,monospace);font-size:9.5px;color:var(--faint,#7d6c58);margin-bottom:2px}
  .sup-wait{align-self:flex-start;color:var(--faint,#7d6c58);font-size:11.5px}
 /* Super 轮次流式 live 气泡(与主聊天同款 task-reply/think-card;末尾光标) */
  #supLiveStream.sup-live{display:flex;flex-direction:column;gap:6px;min-width:0}
  #supLiveStream .task-reply::after{content:"▍";color:var(--bronze,#c98f45);margin-left:1px;animation:supCursor 1s steps(1) infinite}
  @keyframes supCursor{50%{opacity:0}}
  .sup-boardcol{display:flex;flex-direction:column;gap:10px;min-height:0;overflow-y:auto}
  .sup-sec{border:1px solid var(--border-soft,rgba(201,143,69,.2));border-radius:12px;background:var(--surf-card,rgba(255,255,255,.02));padding:8px 10px;flex:0 0 auto}
  .sup-sec-h{font-size:10.5px;letter-spacing:1px;color:var(--faint,#7d6c58);margin-bottom:6px;display:flex;align-items:center;gap:6px}
  .sup-cnt{font-family:var(--mono,ui-monospace,monospace);color:var(--bronze,#c98f45)}
  .sup-list{display:flex;flex-direction:column;gap:6px}
  .sup-row{border:1px solid var(--border-soft,rgba(201,143,69,.2));border-radius:9px;padding:6px 9px;background:rgba(255,255,255,.02);font-size:12px;line-height:1.5}
  .sup-row.hot{border-color:var(--bronze,#c98f45)}
  .sup-row.click{cursor:pointer}
  .sup-row.click:hover{border-color:var(--bronze,#c98f45)}
  .sup-row-h{display:flex;align-items:center;gap:6px;min-width:0}
  .sup-badge{font-size:10px;padding:0 6px;border-radius:5px;border:1px solid var(--border-soft,rgba(201,143,69,.3));color:var(--bronze,#c98f45);flex:0 0 auto}
  .sup-badge.running,.sup-badge.queued{color:var(--accent-bright,#e8b978)}
  .sup-badge.failed,.sup-badge.blocked{color:var(--accent2,#e08a7a);border-color:rgba(224,138,122,.45)}
  .sup-badge.done{color:var(--muted,#a08e78)}
  .sup-it{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sup-mono{font-family:var(--mono,ui-monospace,monospace);font-size:10px;color:var(--faint,#7d6c58)}
  .sup-sum{color:var(--muted,#a08e78);font-size:11px;margin-top:2px;word-break:break-word}
  .sup-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}
  .sup-btn{border:1px solid var(--border-soft,rgba(201,143,69,.3));background:transparent;color:var(--text,#ece1d1);font:inherit;font-size:11px;padding:2px 9px;border-radius:6px;cursor:pointer}
  .sup-btn:hover{border-color:var(--bronze,#c98f45)}
  .sup-btn.pri{background:var(--bubble-a,rgba(201,143,69,.14));border-color:var(--bronze,#c98f45);color:var(--accent-bright,#e8b978)}
  .sup-btn.mut{color:var(--faint,#7d6c58)}
  .sup-empty{color:var(--faint,#7d6c58);font-size:11px;line-height:1.6}
  .sup-answer{display:flex;gap:6px;margin-top:6px}
  .sup-answer input{flex:1 1 auto;min-width:0;background:rgba(0,0,0,.28);border:1px solid var(--border-soft,rgba(201,143,69,.24));border-radius:6px;color:var(--text,#ece1d1);font:inherit;padding:4px 7px;outline:none}
  .sup-proj-h{display:flex;align-items:center;gap:6px;font-size:11.5px;margin-top:5px}
  .sup-proj-t{font-size:11px;color:var(--faint,#7d6c58);letter-spacing:1px}
 /* 关卡 Gate TTL 倒计时(≤10s 变红)与 Fleet 负载条 */
  .gate-ttl{font-family:var(--mono,ui-monospace,monospace);font-size:10px;color:var(--faint,#7d6c58);flex:0 0 auto}
  .gate-ttl.hot{color:var(--accent2,#e08a7a);font-weight:700}
  .loadbar{height:4px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden;min-width:56px}
  .loadbar i{display:block;height:100%;background:var(--bronze,#c98f45)}
 /* 旧 superLayout 双列与画布竖排退役(IDE 三栏接管);看板四区隐藏保留(P1 收编) */
  #superBoardCol{display:none}
`;
