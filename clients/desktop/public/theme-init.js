(function initializeTheme() {
  var theme = 'black-gold'

  try {
    var storedTheme = window.localStorage.getItem('app-theme')
    if (storedTheme === 'black-gold' || storedTheme === 'light') {
      theme = storedTheme
    }
  } catch (_error) {
    // Storage can be unavailable in restricted WebViews. The brand default remains usable.
  }

  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark'
})()
