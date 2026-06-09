// Japan 2026 Travel Blog

// ── Lazy-load images ─────────────────────────────────────────
document.querySelectorAll('.photo-thumb').forEach(img => {
  if (img.complete) {
    img.classList.add('loaded');
  } else {
    img.addEventListener('load', () => img.classList.add('loaded'));
  }
});

// ── Lightbox ──────────────────────────────────────────────────
const lightbox  = document.getElementById('lightbox');
const lbImg     = document.getElementById('lb-img');
const lbCounter = document.getElementById('lb-counter');

let photos = [];
let currentIdx = 0;

function buildIndex() {
  photos = [];
  document.querySelectorAll('.photo-btn').forEach(btn => {
    photos.push(btn.dataset.src);
    btn.dataset.globalIdx = photos.length - 1;
  });
}

function openLightbox(idx) {
  currentIdx = idx;
  lightbox.classList.add('open');
  document.body.style.overflow = 'hidden';
  showPhoto(idx);
}

function closeLightbox() {
  lightbox.classList.remove('open');
  document.body.style.overflow = '';
}

function showPhoto(idx) {
  if (idx < 0 || idx >= photos.length) return;
  currentIdx = idx;
  lbImg.src = photos[idx];
  lbCounter.textContent = `${idx + 1} / ${photos.length}`;
}

document.querySelectorAll('.photo-btn').forEach(btn => {
  btn.addEventListener('click', () => openLightbox(Number(btn.dataset.globalIdx)));
});

document.getElementById('lb-close').addEventListener('click', closeLightbox);
document.getElementById('lb-prev').addEventListener('click', () => showPhoto(currentIdx - 1));
document.getElementById('lb-next').addEventListener('click', () => showPhoto(currentIdx + 1));

lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });

document.addEventListener('keydown', e => {
  if (!lightbox.classList.contains('open')) return;
  if (e.key === 'Escape')     closeLightbox();
  if (e.key === 'ArrowLeft')  showPhoto(currentIdx - 1);
  if (e.key === 'ArrowRight') showPhoto(currentIdx + 1);
});

// Swipe support
let touchStartX = 0;
lightbox.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; });
lightbox.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 50) showPhoto(dx < 0 ? currentIdx + 1 : currentIdx - 1);
});

buildIndex();

// ── Active nav (Intersection Observer) ───────────────────────
const navLinks = document.querySelectorAll('.nav-day-link');
const sections = document.querySelectorAll('.day-section');

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const id = entry.target.id;
    navLinks.forEach(link => link.classList.toggle('active', link.dataset.target === id));

    // Scroll active link into view in mobile horizontal nav
    const active = document.querySelector(`.nav-day-link[data-target="${id}"]`);
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  });
}, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });

sections.forEach(s => observer.observe(s));

// Smooth scroll for nav clicks
navLinks.forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const target = document.getElementById(link.dataset.target);
    if (target) target.scrollIntoView({ behavior: 'smooth' });
  });
});

