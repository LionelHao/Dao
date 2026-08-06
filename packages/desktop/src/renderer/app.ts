export function renderEmptyGroupChat(root: HTMLElement): void {
  const section = document.createElement("section");
  const title = document.createElement("h1");
  const description = document.createElement("p");

  section.dataset.testid = "empty-group-chat";
  section.className = "empty-group-chat";
  title.textContent = "还没有消息";
  description.textContent = "邀请真人或编制 agent 后开始协作";

  section.append(title, description);
  root.replaceChildren(section);
}
