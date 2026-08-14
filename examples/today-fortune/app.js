const fortunes = {
  事业: {
    上签: { verse: "长风正借青云势，一步从容一境开。", meaning: "眼前适合主动推进，但真正的好运来自准备充分后的果断。", actions: ["先完成今天最重要的一件事", "主动确认一个关键节点", "把长期目标拆成下一步"] },
    中签: { verse: "山路虽遥终有径，稳行自会见晴光。", meaning: "进展可能没有想象中快，守住节奏比临时加速更重要。", actions: ["缩小今天的任务范围", "为风险预留一段时间", "向可信同伴核对方向"] },
    下签: { verse: "雾里行舟宜缓桨，灯前细看旧罗盘。", meaning: "今天适合校准而非冒进，下签只是提醒，不代表失败。", actions: ["暂停一个高风险决定", "检查容易忽略的细节", "给自己安排一次短休息"] },
  },
  感情: {
    上签: { verse: "花信轻来春有约，真心一语胜千言。", meaning: "真诚表达容易得到温暖回应，适合让关系更清晰。", actions: ["说出一句具体的感谢", "认真倾听对方五分钟", "安排一次不被打扰的相处"] },
    中签: { verse: "月映双溪各自明，相逢不必问归程。", meaning: "保留彼此空间会让关系更舒展，不必急于定义所有答案。", actions: ["先确认对方真实感受", "减少一次无根据的猜测", "把需求说清而不指责"] },
    下签: { verse: "风过帘栊声未定，且将心事慢慢听。", meaning: "情绪可能放大误解，慢一点回应会比立刻争辩更有效。", actions: ["重要消息延后十分钟回复", "用事实替代情绪判断", "必要时礼貌结束争论"] },
  },
  财运: {
    上签: { verse: "细水汇流成远海，良机恰在算分明。", meaning: "清晰规划能放大已有机会，适合稳健积累而非冲动下注。", actions: ["记录今天全部支出", "复查一项长期预算", "优先处理确定性收益"] },
    中签: { verse: "金玉有时藏璞里，量入为出自安然。", meaning: "今天的重点是守住平衡，小幅优化比追逐意外之财可靠。", actions: ["取消一项非必要消费", "为下月留出固定储备", "比较价格后再做决定"] },
    下签: { verse: "潮来潮去寻常事，守得清醒便是盈。", meaning: "下签提醒你避开冲动和不透明承诺，保全本金就是收获。", actions: ["拒绝来历不明的邀约", "不在情绪中做购买决定", "检查自动续费与订阅"] },
  },
};

const nickname = document.querySelector("#nickname");
const hint = document.querySelector("#nameHint");
const draw = document.querySelector("#drawButton");
const redraw = document.querySelector("#redrawButton");
const result = document.querySelector("#result");
const loading = document.querySelector("#loading");
const content = document.querySelector("#fortuneContent");
let drawing = false;

function selectedTopic() {
  return document.querySelector('input[name="topic"]:checked').value;
}

function validName() {
  const value = nickname.value.trim();
  hint.textContent = value ? "" : "请先写下昵称，再为今天抽一支签。";
  return value;
}

function render() {
  const name = validName();
  if (!name || drawing) return;
  drawing = true;
  draw.disabled = true;
  result.hidden = false;
  loading.hidden = false;
  content.hidden = true;
  window.setTimeout(() => {
    const topic = selectedTopic();
    const levels = ["上签", "中签", "下签"];
    const level = levels[Math.floor(Math.random() * levels.length)];
    const item = fortunes[topic][level];
    document.querySelector("#resultMeta").textContent = `${name} · 今日提示`;
    document.querySelector("#level").textContent = level;
    document.querySelector("#topicBadge").textContent = topic;
    document.querySelector("#verse").textContent = item.verse;
    document.querySelector("#meaning").textContent = item.meaning;
    document.querySelector("#actions").replaceChildren(...item.actions.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
    loading.hidden = true;
    content.hidden = false;
    draw.disabled = false;
    drawing = false;
    result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 1000);
}

draw.addEventListener("click", render);
redraw.addEventListener("click", render);
nickname.addEventListener("input", () => {
  if (nickname.value.trim()) hint.textContent = "";
});
