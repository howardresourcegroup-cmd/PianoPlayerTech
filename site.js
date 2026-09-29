/* PianoPlayerTech — shared page behaviour.
 *
 * Two jobs: open and close the menu on small screens, and mark which page
 * the visitor is on. Both are progressive: with this file missing the links
 * still work, the menu is simply always reachable by scrolling the header.
 */
(function () {
  var toggle = document.querySelector('.pp-nav-toggle');
  var nav = document.getElementById('pp-nav');

  function setOpen(open) {
    if (!toggle || !nav) return;
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    // A tap on a link inside the menu should not leave it covering the page
    // the link just scrolled to.
    nav.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('click', function (e) {
      if (!nav.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { setOpen(false); toggle.focus(); }
    });
  }

  // Cloudflare serves /tuning and /tuning.html as the same page, so compare
  // with the extension and any trailing slash removed.
  function clean(p) {
    return (p || '/').replace(/\/index\.html$/, '/').replace(/\.html$/, '').replace(/\/$/, '') || '/';
  }
  var here = clean(location.pathname);
  var links = document.querySelectorAll('#pp-nav a[href]');
  for (var i = 0; i < links.length; i++) {
    var href = links[i].getAttribute('href');
    if (href.charAt(0) !== '/') continue;
    if (clean(href.split('#')[0]) === here) links[i].setAttribute('aria-current', 'page');
  }
})();
