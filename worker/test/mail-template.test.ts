import { describe, expect, test } from "bun:test";
import { brand } from "@tempra/design/brand";
import { bindingMailer, type MailBinding, renderMail } from "../src/mail-template";
import { invitationMail } from "../src/operator";
import { onTheListMail, operatorNotice, signInMail } from "../src/signin";

// The one mail template (TEMPRA-287, tempra-dev v2/accounts.md, The email).

describe("the mail template", () => {
  const mail = renderMail({
    headline: "Hello <there>",
    line: "One line.",
    button: { label: "Go", href: "https://x.example/a?b=1&c=2" },
    code: { label: "Code", value: "K7QMX2PD" },
    foot: "Small print.",
  });

  test("an HTML part: the mark and name, headline, line, button, code and foot, escaped", () => {
    expect(mail.html).toStartWith("<!doctype html>");
    expect(mail.html).toContain('<svg width="14" height="16" viewBox="0 0 45 50"');
    expect(mail.html).toContain(">Tempra</td>");
    expect(mail.html).toContain(">Hello &#60;there&#62;</h1>");
    expect(mail.html).toContain('href="https://x.example/a?b=1&#38;c=2"');
    expect(mail.html).toContain(">Go</a>");
    expect(mail.html).toContain(">K7QMX2PD</td>");
    expect(mail.html).toContain(">Small print.</p>");
    expect(mail.html).not.toMatch(/<script|<img/);
  });

  test("light inline, dark under prefers-color-scheme, both from the design package", () => {
    expect(mail.html).toContain(`background:${brand.light.bg}`);
    expect(mail.html).toContain(`color:${brand.light.text}`);
    expect(mail.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(mail.html).toContain("@media (prefers-color-scheme:dark)");
    expect(mail.html).toContain(`.t-bg{background:${brand.dark.bg}!important}`);
    expect(mail.html).toContain(`.t-text{color:${brand.dark.text}!important}`);
  });

  test("Tempra's one accent: a short orange rule over the headline, light and dark", () => {
    expect(mail.html).toContain(`class="t-accent"`);
    expect(mail.html).toContain(`background:${brand.light.agent}`);
    expect(mail.html).toContain(`.t-accent{background:${brand.dark.agent}!important}`);
  });

  test("items as links with their excerpts, and links after the small print", () => {
    const m = renderMail({
      headline: "2 new notifications",
      line: "L.",
      items: [
        { title: "@bo replied <here>", href: "https://x.example/a", excerpt: "Quote" },
        { title: "Second", href: "https://x.example/b" },
      ],
      foot: "Foot.",
      footLinks: [{ label: "Unsubscribe", href: "https://x.example/u" }],
    });
    expect(m.html).toContain('href="https://x.example/a"');
    expect(m.html).toContain(">@bo replied &#60;here&#62;</a>");
    expect(m.html).toContain(">Quote</p>");
    expect(m.html).toContain(">Unsubscribe</a>");
    expect(m.text).toBe(
      "2 new notifications\n\nL.\n\n@bo replied <here>\n  Quote\n  https://x.example/a\n\nSecond\n  https://x.example/b\n\nFoot.\nUnsubscribe: https://x.example/u\n",
    );
  });

  test("a text part with the same words and the link", () => {
    expect(mail.text).toBe(
      "Hello <there>\n\nOne line.\n\nGo:\nhttps://x.example/a?b=1&c=2\n\nCode: K7QMX2PD\n\nSmall print.\n",
    );
  });

  test("every mail of the flow is the template, with the approved words", () => {
    const signIn = signInMail("https://t.example/sign-in/link?t=1", "K7QMX2PD");
    expect(signIn.text).toStartWith(
      "Sign in to Tempra\n\nOpen the link, or enter the code on the page that asked for it.",
    );
    expect(signIn.text).toContain("Works once, within 15 minutes. Didn't ask? Ignore this email.");
    expect(onTheListMail().text).toBe(
      "You're on the list\n\nThanks for asking to join Tempra. We'll email you here when you're in.\n\nDidn't ask? Ignore this email.\n",
    );
    const youreIn = invitationMail("https://t.example/sign-in/link?t=2", "https://t.example", true);
    expect(youreIn.text).toContain("You're in\n\nYou asked to join Tempra, and you're in.");
    expect(youreIn.text).toContain("Sign in to Tempra:\nhttps://t.example/sign-in/link?t=2");
    expect(youreIn.text).toContain("After that, sign in with this email at t.example.");
    const notice = operatorNotice("bo@example.org", "https://admin.example", "https://t.example");
    expect(notice.text).toStartWith("bo@example.org asked to join\n\n");
    expect(notice.text).toContain("Open People:\nhttps://admin.example/");
    for (const m of [signIn, onTheListMail(), youreIn, notice]) {
      expect(m.html).toContain("@media (prefers-color-scheme:dark)");
    }
  });
});

describe("the sender", () => {
  test('mail is from "Tempra" at MAIL_FROM', async () => {
    const sent: Parameters<MailBinding["send"]>[0][] = [];
    const binding: MailBinding = {
      async send(m) {
        sent.push(m);
      },
    };
    await bindingMailer(binding, "noreply@mail.tempra.dev").send({
      to: "ann@example.com",
      subject: "Hi",
      text: "t",
      html: "<p>h</p>",
    });
    expect(sent[0]?.from).toEqual({ name: "Tempra", email: "noreply@mail.tempra.dev" });
    expect(sent[0]?.text).toBe("t");
    expect(sent[0]?.html).toBe("<p>h</p>");
  });
});
