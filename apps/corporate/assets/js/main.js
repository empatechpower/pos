/* Rezein Corporate — vanilla JS, no jQuery. Mobile navigation toggle only. */
(function () {
	'use strict';
	var yr = document.getElementById('yr');
	if (yr) {
		yr.textContent = new Date().getFullYear();
	}
	var toggle = document.querySelector('.nav-toggle');
	var nav = document.getElementById('primary-navigation');
	if (!toggle || !nav) {
		return;
	}
	toggle.addEventListener('click', function () {
		var isOpen = nav.classList.toggle('is-open');
		toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
	});
	nav.addEventListener('click', function (event) {
		if (event.target.tagName === 'A') {
			nav.classList.remove('is-open');
			toggle.setAttribute('aria-expanded', 'false');
		}
	});
})();
