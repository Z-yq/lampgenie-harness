/**
 * TTS 音色清单(音色选择+试听)。
 * 真源(官方文档,抓取于):
 * - qwen-audio-3.1-tts-flash / 3.0-tts-plus / 3.0-tts-flash:help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list
 * - qwen3-tts-flash(+realtime):help.aliyun.com/zh/model-studio/qwen-tts-voice-list
 * voice 区分大小写;跨模型混用报 InvalidParameter(官方口径),故清单严格按模型分组。
 * 未知模型(cosyvoice / minimax / 复刻音色等)返回空表——前端走自定义 voice id 兜底,不瞎给清单。
 */

export interface VoiceInfo {
  /** voice 参数(请求体 input.voice 的值,区分大小写)。 */
  id: string;
  name: string;
  gender?: "女" | "男";
  traits?: string;
  group: string;
}

/* eslint-disable perfectionist/sort-objects */
const QA31: VoiceInfo[] = [
  // 多语种与方言(上海/广东/东北/重庆/陕西/云南/宁波/甘肃话 + 日韩法德葡意越印尼)
  { id: "longanhuan_v3.1", name: "龙安欢", gender: "女", traits: "多方言多语种", group: "3.1 多语种方言" },
  { id: "longanlingxin_v3.1", name: "龙安灵心", gender: "女", traits: "多方言多语种", group: "3.1 多语种方言" },
  { id: "longanfengyue_v3.1", name: "龙安风悦", gender: "女", traits: "多方言多语种", group: "3.1 多语种方言" },
  { id: "xunanchuan_v3.1", name: "许南川", gender: "男", traits: "多方言多语种", group: "3.1 多语种方言" },
  // 精品中文(仅普通话)
  { id: "yuxiaoyun_v3.1", name: "于小云", gender: "女", traits: "元气亲切自然", group: "3.1 精品中文" },
  { id: "qiaoxiaojiao_v3.1", name: "乔小娇", gender: "女", traits: "俏丽可爱", group: "3.1 精品中文" },
  { id: "xiaxiaochen_v3.1", name: "夏小晨", gender: "女", traits: "元气明亮", group: "3.1 精品中文" },
  { id: "anmingyuan_v3.1", name: "安明远", gender: "男", traits: "清亮自然", group: "3.1 精品中文" },
  { id: "wenhuaiqing_v3.1", name: "温怀清", gender: "女", traits: "清亮柔和", group: "3.1 精品中文" },
  { id: "anxiaolan_v3.1", name: "安小岚", gender: "女", traits: "清甜纯净", group: "3.1 精品中文" },
  { id: "xieshurou_v3.1", name: "谢舒柔", gender: "女", traits: "柔和知性", group: "3.1 精品中文" },
  { id: "baiqinglan_v3.1", name: "白清岚", gender: "女", traits: "明亮清纯", group: "3.1 精品中文" },
  { id: "xuyuyuan_v3.1", name: "许玉远", gender: "女", traits: "知性成熟质感", group: "3.1 精品中文" },
  { id: "anruorou_v3.1", name: "安若柔", gender: "女", traits: "气声知性", group: "3.1 精品中文" },
  { id: "wenhuaizhi_v3.1", name: "闻怀之", gender: "女", traits: "稳重成熟", group: "3.1 精品中文" },
  { id: "xiaoxingzhi_v3.1", name: "蕧行之", gender: "女", traits: "端庄贵气", group: "3.1 精品中文" },
  { id: "guyunshu_v3.1", name: "顾云舒", gender: "女", traits: "成熟稳重", group: "3.1 精品中文" },
  { id: "huozhuoshi_v3.1", name: "霍拙石", gender: "男", traits: "清亮", group: "3.1 精品中文" },
  { id: "yeqinghe_v3.1", name: "叶清禾", gender: "女", traits: "亲切温柔", group: "3.1 精品中文" },
  { id: "yunhuanhuan_v3.1", name: "云欢欢", gender: "女", traits: "高亢热情", group: "3.1 精品中文" },
  { id: "xuxiaoqiao_v3.1", name: "徐小俏", gender: "女", traits: "自然俏皮", group: "3.1 精品中文" },
  { id: "baianran_v3.1", name: "白安然", gender: "女", traits: "低沉浑厚气声", group: "3.1 精品中文" },
  { id: "xuyanchu_v3.1", name: "许言初", gender: "女", traits: "沉稳磁性", group: "3.1 精品中文" },
  { id: "yezhiqing_v3.1", name: "叶知晴", gender: "女", traits: "轻快自然", group: "3.1 精品中文" },
  { id: "andi_v3.1", name: "安迪", gender: "男", traits: "ABC 口音", group: "3.1 精品中文" },
  { id: "anyuqing_v3.1", name: "安语晴", gender: "女", traits: "甜妹", group: "3.1 精品中文" },
  // 精品英文(仅英文)
  { id: "Emily_v3.1", name: "Emily", gender: "女", traits: "英式女声", group: "3.1 精品英文" },
  { id: "Luna_v3.1", name: "Luna", gender: "女", traits: "英式女声", group: "3.1 精品英文" },
  { id: "Eric_v3.1", name: "Eric", gender: "男", traits: "英式男声", group: "3.1 精品英文" },
  { id: "Luca_v3.1", name: "Luca", gender: "男", traits: "英式男声", group: "3.1 精品英文" },
  { id: "Abby_v3.1", name: "Abby", gender: "女", traits: "美式女声", group: "3.1 精品英文" },
  { id: "Annie_v3.1", name: "Annie", gender: "女", traits: "美式女声", group: "3.1 精品英文" },
  { id: "Ava_v3.1", name: "Ava", gender: "女", traits: "美式女声", group: "3.1 精品英文" },
  { id: "Beth_v3.1", name: "Beth", gender: "女", traits: "美式女声", group: "3.1 精品英文" },
  { id: "Betty_v3.1", name: "Betty", gender: "女", traits: "美式女声", group: "3.1 精品英文" },
  { id: "Cally_v3.1", name: "Cally", gender: "女", traits: "美式女声", group: "3.1 精品英文" },
  { id: "Cindy_v3.1", name: "Cindy", gender: "女", traits: "美式女声", group: "3.1 精品英文" },
  { id: "Donna_v3.1", name: "Donna", gender: "女", traits: "美式女声", group: "3.1 精品英文" },
  { id: "Andy_v3.1", name: "Andy", gender: "男", traits: "美式男声", group: "3.1 精品英文" },
  { id: "Brian_v3.1", name: "Brian", gender: "男", traits: "美式男声", group: "3.1 精品英文" },
  { id: "David_v3.1", name: "David", gender: "男", traits: "美式男声", group: "3.1 精品英文" },
  // 其他系统音色(角色/陪伴/童声等)
  { id: "longanyuanfei_v3.1", name: "龙安元妃", gender: "女", traits: "高傲妃子音", group: "3.1 角色/其他" },
  { id: "longjielidou_v3.1", name: "龙杰力豆", gender: "男", traits: "天真男童音", group: "3.1 角色/其他" },
  { id: "longanlingxi_v3.1", name: "龙安灵希", gender: "女", traits: "可爱甜美音", group: "3.1 角色/其他" },
  { id: "longhuohuo_v3.1", name: "龙火火", gender: "男", traits: "顽皮少年音", group: "3.1 角色/其他" },
  { id: "longyingtao_v3.1", name: "龙应桃", gender: "女", traits: "温柔淡定", group: "3.1 角色/其他" },
  { id: "longanya_v3.1", name: "龙安雅", gender: "女", traits: "高雅气质", group: "3.1 角色/其他" },
  { id: "longwan_v3.1", name: "龙婉", gender: "女", traits: "细腻柔声", group: "3.1 角色/其他" },
  { id: "longxing_v3.1", name: "龙星", gender: "女", traits: "温婉邻家", group: "3.1 角色/其他" },
  { id: "longhua_v3.1", name: "龙华", gender: "女", traits: "元气甜美", group: "3.1 角色/其他" },
  { id: "longhan_v3.1", name: "龙寒", gender: "男", traits: "温暖痴情男", group: "3.1 角色/其他" },
  { id: "longanzhi_v3.1", name: "龙安智", gender: "男", traits: "睿智轻熟男", group: "3.1 角色/其他" },
  { id: "longzhe_v3.1", name: "龙哲", gender: "男", traits: "呆板大暖男", group: "3.1 角色/其他" },
  { id: "longanyang_v3.1", name: "龙安洋", gender: "男", traits: "阳光大男孩(标杆)", group: "3.1 角色/其他" },
  { id: "libai_v3.1", name: "李白", gender: "男", traits: "古代诗仙", group: "3.1 角色/其他" },
  { id: "longling_v3.1", name: "龙铃", gender: "女", traits: "稚气童声", group: "3.1 角色/其他" },
  { id: "longniuniu_v3.1", name: "龙牛牛", gender: "男", traits: "阳光男童声", group: "3.1 角色/其他" },
  { id: "longshanshan_v3.1", name: "龙闪闪", gender: "男", traits: "戏剧化童声", group: "3.1 角色/其他" },
  { id: "longpaopao_v3.1", name: "龙泡泡", gender: "女", traits: "飞天泡泡音", group: "3.1 角色/其他" },
  { id: "loongstella_v3.1", name: "loongstella", gender: "女", traits: "飒爽利落", group: "3.1 角色/其他" },
  { id: "longyuan_v3.1", name: "龙媛", gender: "女", traits: "温暖治愈", group: "3.1 角色/其他" },
  { id: "longmiao_v3.1", name: "龙妙", gender: "女", traits: "抑扬顿挫", group: "3.1 角色/其他" },
  { id: "longsanshu_v3.1", name: "龙三叔", gender: "男", traits: "沉稳质感", group: "3.1 角色/其他" },
  { id: "longanli_v3.1", name: "龙安莉", gender: "女", traits: "利落从容", group: "3.1 角色/其他" },
  { id: "longanwen_v3.1", name: "龙安温", gender: "女", traits: "优雅知性", group: "3.1 角色/其他" },
  { id: "longanlang_v3.1", name: "龙安朗", gender: "男", traits: "清爽利落", group: "3.1 角色/其他" },
  { id: "longxiaoxia_v3.1", name: "龙小夏", gender: "女", traits: "沉稳权威", group: "3.1 角色/其他" },
  { id: "longanchong_v3.1", name: "龙安冲", gender: "男", traits: "激情推销", group: "3.1 角色/其他" },
];

const QA30_PLUS: VoiceInfo[] = [
  { id: "longanlingxin", name: "龙安灵心", gender: "女", traits: "知心温暖·旗舰", group: "3.0 plus" },
  { id: "longanlufeng", name: "龙安鲁风", gender: "男", traits: "明亮开朗·旗舰", group: "3.0 plus" },
];

const QA30_FLASH: VoiceInfo[] = [
  { id: "longanfengyue", name: "龙安风悦", gender: "女", traits: "自然亲切", group: "3.0 flash 精品中文" },
  { id: "longanyuanfei", name: "龙安元妃", gender: "女", traits: "高傲妃子音", group: "3.0 flash 精品中文" },
  { id: "longanlingxi", name: "龙安灵希", gender: "女", traits: "可爱甜美", group: "3.0 flash 精品中文" },
  { id: "longanxiaoxin", name: "龙安小昕", gender: "女", traits: "亲切活泼", group: "3.0 flash 精品中文" },
  { id: "longanhuan_v3.6", name: "龙安欢", gender: "女", traits: "社交陪伴", group: "3.0 flash 精品中文" },
  { id: "longjielidou_v3.6", name: "龙杰力豆", gender: "男", traits: "天真男童", group: "3.0 flash 儿童" },
  { id: "longpaopao_v3.6", name: "龙泡泡", gender: "女", traits: "软糯可爱", group: "3.0 flash 儿童" },
  { id: "longhuohuo_v3.6", name: "龙火火", gender: "男", traits: "顽皮少年", group: "3.0 flash 角色" },
  { id: "longchuanshu_v3.6", name: "龙川叔", gender: "男", traits: "川普大叔", group: "3.0 flash 角色" },
  { id: "loongmary", name: "loongmary", gender: "女", traits: "温暖英音", group: "3.0 flash 英文" },
  { id: "loongeva_v3.6", name: "loongeva", gender: "女", traits: "高智美音", group: "3.0 flash 英文" },
  { id: "loongjohn", name: "loongJohn", gender: "男", traits: "沉稳美音", group: "3.0 flash 英文" },
];

const Q3TTS: VoiceInfo[] = [
  { id: "Cherry", name: "芊悦", gender: "女", traits: "阳光亲切", group: "qwen3 标准音色" },
  { id: "Serena", name: "苏瑶", gender: "女", traits: "温柔", group: "qwen3 标准音色" },
  { id: "Ethan", name: "晨煦", gender: "男", traits: "阳光活力", group: "qwen3 标准音色" },
  { id: "Chelsie", name: "千雪", gender: "女", traits: "二次元女友", group: "qwen3 标准音色" },
  { id: "Momo", name: "茉兔", gender: "女", traits: "撒娇搞怪", group: "qwen3 标准音色" },
  { id: "Vivian", name: "十三", gender: "女", traits: "可爱小暴躁", group: "qwen3 标准音色" },
  { id: "Moon", name: "月白", gender: "男", traits: "率性帅气", group: "qwen3 标准音色" },
  { id: "Maia", name: "四月", gender: "女", traits: "知性温柔", group: "qwen3 标准音色" },
  { id: "Kai", name: "凯", gender: "男", traits: "耳语治愈", group: "qwen3 标准音色" },
  { id: "Nofish", name: "不吃鱼", gender: "男", traits: "设计师", group: "qwen3 标准音色" },
  { id: "Bella", name: "萌宝", gender: "女", traits: "小萝莉", group: "qwen3 标准音色" },
  { id: "Jennifer", name: "詹妮弗", gender: "女", traits: "电影质感美语", group: "qwen3 标准音色" },
  { id: "Ryan", name: "甜茶", gender: "男", traits: "戏感张力", group: "qwen3 标准音色" },
  { id: "Katerina", name: "卡捷琳娜", gender: "女", traits: "御姐韵律", group: "qwen3 标准音色" },
  { id: "Aiden", name: "艾登", gender: "男", traits: "美语大男孩", group: "qwen3 标准音色" },
  { id: "Eldric Sage", name: "沧明子", gender: "男", traits: "沉稳睿智老者", group: "qwen3 标准音色" },
  { id: "Mia", name: "乖小妹", gender: "女", traits: "温顺乖巧", group: "qwen3 标准音色" },
  { id: "Mochi", name: "沙小弥", gender: "男", traits: "早慧小大人", group: "qwen3 标准音色" },
  { id: "Bellona", name: "燕铮莺", gender: "女", traits: "洪亮鲜活", group: "qwen3 标准音色" },
  { id: "Vincent", name: "田叔", gender: "男", traits: "沙哑烟嗓", group: "qwen3 标准音色" },
  { id: "Bunny", name: "萌小姬", gender: "女", traits: "萌属性萝莉", group: "qwen3 标准音色" },
  { id: "Neil", name: "阿闻", gender: "男", traits: "新闻主持人", group: "qwen3 标准音色" },
  { id: "Elias", name: "墨讲师", gender: "女", traits: "知识讲师", group: "qwen3 标准音色" },
  { id: "Arthur", name: "徐大爷", gender: "男", traits: "质朴村史", group: "qwen3 标准音色" },
  { id: "Nini", name: "邻家妹妹", gender: "女", traits: "软黏甜", group: "qwen3 标准音色" },
  { id: "Seren", name: "小婉", gender: "女", traits: "舒缓助眠", group: "qwen3 标准音色" },
  { id: "Pip", name: "顽屁小孩", gender: "男", traits: "调皮童真", group: "qwen3 标准音色" },
  { id: "Stella", name: "少女阿月", gender: "女", traits: "迷糊少女", group: "qwen3 标准音色" },
  { id: "Bodega", name: "博德加", gender: "男", traits: "西班牙大叔", group: "qwen3 标准音色" },
  { id: "Sonrisa", name: "索尼莎", gender: "女", traits: "拉美大姐", group: "qwen3 标准音色" },
  { id: "Alek", name: "阿列克", gender: "男", traits: "冷峻俄罗斯", group: "qwen3 标准音色" },
  { id: "Dolce", name: "多尔切", gender: "男", traits: "慵懒意大利", group: "qwen3 标准音色" },
  { id: "Sohee", name: "素熙", gender: "女", traits: "韩国欧尼", group: "qwen3 标准音色" },
  { id: "Ono Anna", name: "小野杏", gender: "女", traits: "青梅竹马", group: "qwen3 标准音色" },
  { id: "Lenn", name: "莱恩", gender: "男", traits: "理性德国青年", group: "qwen3 标准音色" },
  { id: "Emilien", name: "埃米尔安", gender: "男", traits: "浪漫法国", group: "qwen3 标准音色" },
  { id: "Andre", name: "安德雷", gender: "男", traits: "磁性沉稳", group: "qwen3 标准音色" },
  { id: "Radio Gol", name: "拉迪奥·戈尔", gender: "男", traits: "足球解说", group: "qwen3 标准音色" },
  { id: "Jada", name: "上海-阿珍", gender: "女", traits: "上海话", group: "qwen3 方言" },
  { id: "Dylan", name: "北京-晓东", gender: "男", traits: "北京话", group: "qwen3 方言" },
  { id: "Li", name: "南京-老李", gender: "男", traits: "南京话", group: "qwen3 方言" },
  { id: "Marcus", name: "陕西-秦川", gender: "男", traits: "陕西话", group: "qwen3 方言" },
  { id: "Roy", name: "闽南-阿杰", gender: "男", traits: "闽南语", group: "qwen3 方言" },
  { id: "Peter", name: "天津-李彼得", gender: "男", traits: "天津话", group: "qwen3 方言" },
  { id: "Sunny", name: "四川-晴儿", gender: "女", traits: "四川话", group: "qwen3 方言" },
  { id: "Eric", name: "四川-程川", gender: "男", traits: "四川话", group: "qwen3 方言" },
  { id: "Rocky", name: "粤语-阿强", gender: "男", traits: "粤语", group: "qwen3 方言" },
  { id: "Kiki", name: "粤语-阿清", gender: "女", traits: "粤语", group: "qwen3 方言" },
];
/* eslint-enable perfectionist/sort-objects */

/** 按模型取音色清单;未知模型=空数组(前端走自定义 voice id)。 */
export function voicesForModel(model: string): VoiceInfo[] {
  if (!model) return [];
  if (model.includes("qwen-audio-3.1-tts")) return QA31;
  if (model.includes("qwen-audio-3.0-tts-plus")) return QA30_PLUS;
  if (model.includes("qwen-audio-3.0-tts")) return QA30_FLASH;
  if (model.includes("qwen3-tts")) return Q3TTS;
  return [];
}
