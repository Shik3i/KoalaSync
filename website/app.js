// KoalaSync Landing Page Logic

document.addEventListener('DOMContentLoaded', () => {
    // Scroll Reveal Logic
    const revealElements = document.querySelectorAll('[data-reveal]');
    
    const revealOnScroll = () => {
        const windowHeight = window.innerHeight;
        revealElements.forEach(el => {
            const elementTop = el.getBoundingClientRect().top;
            const revealPoint = 150;

            if (elementTop < windowHeight - revealPoint) {
                el.classList.add('revealed');
            }
        });
    };

    // Initial check
    revealOnScroll();

    // Scroll listener
    window.addEventListener('scroll', revealOnScroll);

    // Navbar scroll effect
    const nav = document.querySelector('nav');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            nav.style.padding = '0.75rem 0';
            nav.style.background = 'rgba(15, 23, 42, 0.9)';
        } else {
            nav.style.padding = '1rem 0';
            nav.style.background = 'rgba(30, 41, 59, 0.7)';
        }
    });

    // Smooth scroll for anchors
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
});
