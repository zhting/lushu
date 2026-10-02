module.exports = {
  apps: [
    {
      name: 'lushu-backend',
      script: './server/index.js',
      cwd: '/var/www/lushu',
      env: {
        NODE_ENV: 'production',
        PORT: 3020,
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
    },
  ],
}
