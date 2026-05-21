let currentWheelIndex = 1;
            let isScrolling = false;
            let wheelTimer = null;

            const wheel = document.querySelector('.analysisPageButtons');
            const choices = document.querySelectorAll('.analysisPageButton');
            const numbers = document.querySelectorAll('.extAnalysisPN');
            const wheelContainer = document.querySelector('.wheel');

            function updateWheel() {
                wheel.style.transform = `rotateX(${currentWheelIndex * 40}deg)`;

                clearTimeout(wheelTimer);

                choices.forEach((c, i) => {
                    c.classList.toggle('active', i === currentWheelIndex);
                });

                wheelTimer = setTimeout(() => {
                    const activeChoice = choices[currentWheelIndex];
                    const target = document.querySelector(activeChoice.getAttribute('data-target'));
                    const slug = document.querySelector(activeChoice.getAttribute('data-slug'));
                    const contents = document.querySelectorAll('.analysisPage');
                    const pageNums = document.querySelectorAll('.extAnalysisPN');

                    contents.forEach(c => {
                        c.style.display = 'none';
                    });

                    pageNums.forEach(p => {
                        p.classList.remove('active');
                    });


                    if (target && slug) {
                        target.style.display = 'flex';
                        slug.classList.add('active');
                    }
                    
                }, 1000)
            }

            updateWheel();

            wheelContainer.addEventListener('wheel', (e) => {
                e.preventDefault();

                if (isScrolling) return;

                if (Math.abs(e.deltaY) > 1) {

                    if (e.deltaY > 0 && currentWheelIndex < 2) {
                        currentWheelIndex++;
                    } else if (e.deltaY < 0 && currentWheelIndex > 0) {
                        currentWheelIndex--;
                    }

                    updateWheel();

                    setTimeout(() => { isScrolling = false;}, 600);
                }
            }, {passive: false});

            choices.forEach((c, i) => {
                c.addEventListener('click', () => {

                    if (currentWheelIndex === i) return;

                    currentWheelIndex = i;

                    const target = document.querySelector(c.getAttribute('data-target'));
                    const slug = document.querySelector(c.getAttribute('data-slug'));
                    const contents = document.querySelectorAll('.analysisPage');
                    const pageNums = document.querySelectorAll('.extAnalysisPN');
                                        
                    contents.forEach(c => {
                        c.style.display = 'none';
                    });

                    
                    choices.forEach(c2 => {
                        c2.classList.remove('active');
                    });

                    pageNums.forEach(p => {
                        p.classList.remove('active');
                    });

                    c.classList.add('active');

                    if (target && slug) {
                        target.style.display = 'flex';
                        slug.classList.add('active');
                    }

                    updateWheel();

                });
            });

            numbers.forEach((n, i) => {
                n.addEventListener('click', () => {

                    if (currentWheelIndex === i) return;

                    currentWheelIndex = i;

                    const target = document.querySelector(n.getAttribute('data-target'));
                    const slug = document.querySelector(n.getAttribute('data-slug'));
                    const contents = document.querySelectorAll('.analysisPage');
                    const pageButtons = document.querySelectorAll('.analysisPageButton');
                                        
                    contents.forEach(c => {
                        c.style.display = 'none';
                    });
                    
                    numbers.forEach(n2 => {
                        n2.classList.remove('active');
                    });

                    pageButtons.forEach(p => {
                        p.classList.remove('active');
                    });

                    n.classList.add('active');

                    if (target && slug) {
                        target.style.display = 'flex';
                        slug.classList.add('active');
                    }

                    updateWheel();

                });
            });