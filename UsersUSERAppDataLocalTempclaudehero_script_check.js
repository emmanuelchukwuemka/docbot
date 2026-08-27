
  // Set this to your live MigraTech WhatsApp number in international format, digits only
  // (e.g. "2348012345678"), once the bot's number is registered and paired — see README.
  const WHATSAPP_NUMBER = "";
  function waHref(text) {
    return WHATSAPP_NUMBER
      ? "https://wa.me/" + WHATSAPP_NUMBER + "?text=" + encodeURIComponent(text)
      : "#top";
  }
  const defaultHref = waHref("Hi, I'd like to explore migration options.");
  for (const id of ["navCta", "heroCta", "footCta", "footLinkCta"]) {
    document.getElementById(id).href = defaultHref;
  }
  const pathwayIntents = {
    pathLinkWork: "Hi, I want to explore work abroad options.",
    pathLinkStudy: "Hi, I want to explore study abroad options.",
    pathLinkFamily: "Hi, I want to explore family migration options.",
    pathLinkBusiness: "Hi, I want to explore business & investment migration options.",
    pathLinkVisit: "Hi, I want to explore visit options.",
    pathLinkUnsure: "Hi, I'm not sure yet which migration path is right for me.",
  };
  for (const [id, text] of Object.entries(pathwayIntents)) {
    document.getElementById(id).href = waHref(text);
  }
  document.getElementById("year").textContent = new Date().getFullYear();

  // ---- Hero phone: a real, looping back-and-forth demo conversation ----
  (function chatDemo() {
    const body = document.getElementById("chatBody");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const script = [
      { dir: "in", text: "Hello! 👋 I'm MigraTech. I help you explore legitimate migration pathways to study, work, or relocate. What would you like to do?", wait: 900 },
      { dir: "out", text: "Hi! I want to relocate to Germany for work 🇩🇪", wait: 1100 },
      { dir: "typing", wait: 1200 },
      { dir: "in", text: "Great, I can help you explore legitimate migration pathways to Germany. Let's get a bit more detail.<br>What is your occupation?", wait: 1500 },
      { dir: "out", text: "Software engineer, 6 years experience", wait: 1200 },
      { dir: "typing", wait: 1400 },
      { dir: "in", text: "✅ Based on what you've shared, you may have a potentially suitable profile.<br><br>Potential option: <b>Germany — Skilled Worker Route</b>", wait: 2000 },
      { dir: "typing", wait: 900 },
      { dir: "in", text: "⬜ International passport<br>⬜ Academic certificates<br>✅ CV", wait: 4200 },
    ];

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, reduced ? 0 : ms));
    }
    function timestamp() {
      return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    function addMessage(dir, html) {
      const el = document.createElement("div");
      el.className = "msg " + dir;
      el.innerHTML = html + "<time>" + timestamp() + "</time>";
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
    }
    function addTyping() {
      const el = document.createElement("div");
      el.className = "typing";
      el.innerHTML = "<span></span><span></span><span></span>";
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
      return el;
    }

    async function play() {
      body.innerHTML = "";
      for (const step of script) {
        if (step.dir === "typing") {
          const typingEl = addTyping();
          await sleep(step.wait);
          typingEl.remove();
        } else {
          addMessage(step.dir, step.text);
          await sleep(step.wait);
        }
      }
      if (!reduced) {
        await sleep(2800);
        play();
      }
    }
    play();
  })();

  // ---- Pathways slider (arrow + dot controlled, no autoplay) ----
  (function pathSlider() {
    const track = document.getElementById("pathTrack");
    const prev = document.getElementById("pathPrev");
    const next = document.getElementById("pathNext");
    const dotsWrap = document.getElementById("pathDots");
    const cards = Array.from(track.children);

    cards.forEach((_, i) => {
      const dot = document.createElement("button");
      dot.className = "slider-dot";
      dot.setAttribute("aria-label", "Go to pathway " + (i + 1));
      dot.addEventListener("click", () => cards[i].scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" }));
      dotsWrap.appendChild(dot);
    });
    const dots = Array.from(dotsWrap.children);

    function cardStep() {
      const style = getComputedStyle(cards[0]);
      return cards[0].getBoundingClientRect().width + parseFloat(style.marginRight || 0) + 18;
    }
    function syncUI() {
      const max = track.scrollWidth - track.clientWidth - 2;
      prev.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollLeft >= max;
      const active = Math.round((track.scrollLeft / (track.scrollWidth - track.clientWidth || 1)) * (cards.length - 1));
      dots.forEach((d, i) => d.classList.toggle("is-active", i === active));
    }
    prev.addEventListener("click", () => track.scrollBy({ left: -cardStep(), behavior: "smooth" }));
    next.addEventListener("click", () => track.scrollBy({ left: cardStep(), behavior: "smooth" }));
    track.addEventListener("scroll", () => requestAnimationFrame(syncUI), { passive: true });
    window.addEventListener("resize", syncUI);
    syncUI();
  })();

  // ---- Reveal-on-scroll ----
  (function reveal() {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const els = document.querySelectorAll(".reveal");
    if (reduced) { els.forEach((el) => el.classList.add("is-in")); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
    }, { threshold: 0.15 });
    els.forEach((el) => io.observe(el));
  })();
