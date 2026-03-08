/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/app/**/*.{js,ts,jsx,tsx}", "./src/components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brandPink: '#FD1B77',
        brandPurple: '#E31BFD',
        brandMint: '#1BFDB2',
        brandBlack: '#0A0A0A',
        brandWhite: '#FAFAFA',
      },
      backgroundImage: {
        brandGradient: 'linear-gradient(90deg, #FD1B77 0%, #E31BFD 50%, #1BFDB2 100%)',
      },
    },
  },
  plugins: []
};
