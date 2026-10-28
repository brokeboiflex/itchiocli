/** Hooks inspected on itch.io pages and its community.min.js, 2026-10-28. */
export const S = {
  game: ".game_cell[data-game_id]",
  gameTitle: ".game_title a",
  gameAuthor: ".game_author a",
  gameText: ".game_text",
  comment: ".community_post:not(.moderation_event)",
  commentBody: ".post_body",
  commentAuthor: ".post_author a",
  commentLink: ".post_date a",
  editor: '[contenteditable="true"]:visible, textarea[name="post[body]"]:visible',
  form: "form.post_form",
  upload: ".upload",
  download: "a.download_btn[data-upload_id]",
};
