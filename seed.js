// Наповнення бази даних тестовими даними: користувачі, працівники, клієнти,
// послуги, записи, відгуки та налаштування.
// Запуск: node seed.js
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('./models/User');
const Client = require('./models/Client');
const Employee = require('./models/Employee');
const Service = require('./models/Service');
const Appointment = require('./models/Appointment');
const Review = require('./models/Review');
const Settings = require('./models/Settings');

const addDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
};

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected, seeding...');

  await Promise.all([
    User.deleteMany({}),
    Client.deleteMany({}),
    Employee.deleteMany({}),
    Service.deleteMany({}),
    Appointment.deleteMany({}),
    Review.deleteMany({}),
    Settings.deleteMany({}),
  ]);

  // --- Users (auth accounts) ---
  const usersData = [
    { name: 'Адміністратор', email: 'admin@barbershop.com', password: 'admin123', role: 'admin' },
    { name: 'Олексій Барбер', email: 'barber@barbershop.com', password: 'barber123', role: 'barber' },
    { name: 'Іван Клієнт', email: 'client@barbershop.com', password: 'client123', role: 'client' },
  ];
  const users = [];
  for (const data of usersData) {
    const user = new User(data);
    await user.save(); // pre('save') hashes the password
    users.push(user);
  }
  console.log(`Created ${users.length} users`);

  // --- Employees ---
  const employeesData = [
    {
      name: 'Олексій Барбер',
      phone: '+380501112233',
      email: 'barber@barbershop.com',
      role: 'Barber',
      hourlyRate: 300,
      bio: 'Досвідчений барбер, спеціалізується на класичних та фейд-стрижках.',
      specialties: ['Haircut', 'Beard Trim', 'Shave'],
      rating: 4.8,
      reviewCount: 2,
    },
    {
      name: 'Марина Стиліст',
      phone: '+380671234567',
      email: 'marina@barbershop.com',
      role: 'Barber',
      hourlyRate: 280,
      bio: 'Стиліст із досвідом роботи у преміум барбершопах Києва.',
      specialties: ['Styling', 'Hair Wash', 'Haircut'],
      rating: 4.6,
      reviewCount: 1,
    },
    {
      name: 'Дмитро Рецепшн',
      phone: '+380931234567',
      email: 'dmytro@barbershop.com',
      role: 'Receptionist',
      hourlyRate: 200,
      bio: 'Адміністратор залу, відповідає за запис клієнтів.',
      specialties: [],
      rating: 0,
      reviewCount: 0,
      schedule: {
        mon: { isOpen: true, from: '09:00', to: '18:00' },
        tue: { isOpen: true, from: '09:00', to: '18:00' },
        wed: { isOpen: true, from: '09:00', to: '18:00' },
        thu: { isOpen: true, from: '09:00', to: '18:00' },
        fri: { isOpen: true, from: '09:00', to: '18:00' },
        sat: { isOpen: true, from: '10:00', to: '16:00' },
        sun: { isOpen: false, from: '10:00', to: '16:00' },
      },
    },
    {
      name: 'Андрій Менеджер',
      phone: '+380661234567',
      email: 'andriy@barbershop.com',
      role: 'Manager',
      hourlyRate: 350,
      bio: 'Керівник барбершопу.',
      specialties: ['Haircut'],
      rating: 4.9,
      reviewCount: 0,
    },
  ];
  const employees = await Employee.insertMany(employeesData);
  console.log(`Created ${employees.length} employees`);
  const [barberEmp, marinaEmp] = employees;

  // --- Services ---
  const servicesData = [
    { name: 'Класична стрижка', description: 'Стрижка машинкою та ножицями з укладкою.', price: 350, duration: 40, category: 'Haircut' },
    { name: 'Фейд стрижка', description: 'Стрижка з плавним переходом (fade).', price: 400, duration: 45, category: 'Haircut' },
    { name: 'Оформлення бороди', description: 'Стрижка та моделювання бороди.', price: 250, duration: 30, category: 'Beard Trim' },
    { name: 'Класичне гоління', description: 'Гоління небезпечною бритвою з гарячим рушником.', price: 300, duration: 30, category: 'Shave' },
    { name: 'Миття голови', description: 'Миття голови з професійною косметикою.', price: 100, duration: 15, category: 'Hair Wash' },
    { name: 'Укладка', description: 'Стайлінг та укладка волосся.', price: 150, duration: 20, category: 'Styling' },
    { name: 'Дитяча стрижка', description: 'Стрижка для дітей до 12 років.', price: 250, duration: 30, category: 'Other' },
  ];
  const services = await Service.insertMany(servicesData);
  console.log(`Created ${services.length} services`);
  const [haircut, fade, beard, shave, wash, styling] = services;

  // --- Clients ---
  const clientsData = [
    { name: 'Петро Іваненко', phone: '+380501234567', email: 'petro@example.com' },
    { name: 'Сергій Коваль', phone: '+380631234567', email: 'sergiy@example.com' },
    { name: 'Максим Ткаченко', phone: '+380971234567', email: 'maksym@example.com' },
    { name: 'Богдан Мельник', phone: '+380991234567', email: 'bogdan@example.com' },
    { name: 'Роман Бондаренко', phone: '+380681234567', email: 'roman@example.com' },
    { name: 'Ігор Савченко', phone: '+380731234567', email: 'igor@example.com' },
  ];
  const clients = await Client.insertMany(clientsData);
  console.log(`Created ${clients.length} clients`);

  // --- Appointments ---
  const appointmentsData = [
    {
      client: clients[0]._id, employee: barberEmp._id, services: [haircut._id, beard._id],
      date: addDays(-7), startTime: '10:00', totalDuration: haircut.duration + beard.duration,
      totalPrice: haircut.price + beard.price, status: 'Completed',
    },
    {
      client: clients[1]._id, employee: marinaEmp._id, services: [styling._id, wash._id],
      date: addDays(-5), startTime: '14:00', totalDuration: styling.duration + wash.duration,
      totalPrice: styling.price + wash.price, status: 'Completed',
    },
    {
      client: clients[2]._id, employee: barberEmp._id, services: [fade._id],
      date: addDays(-2), startTime: '11:30', totalDuration: fade.duration,
      totalPrice: fade.price, status: 'Cancelled',
    },
    {
      client: clients[3]._id, employee: barberEmp._id, services: [shave._id, beard._id],
      date: addDays(-1), startTime: '16:00', totalDuration: shave.duration + beard.duration,
      totalPrice: shave.price + beard.price, status: 'No-show',
    },
    {
      client: clients[4]._id, employee: marinaEmp._id, services: [haircut._id],
      date: addDays(0), startTime: '09:30', totalDuration: haircut.duration,
      totalPrice: haircut.price, status: 'Scheduled',
    },
    {
      client: clients[0]._id, employee: barberEmp._id, services: [fade._id, beard._id],
      date: addDays(1), startTime: '13:00', totalDuration: fade.duration + beard.duration,
      totalPrice: fade.price + beard.price, status: 'Scheduled',
    },
    {
      client: clients[5]._id, employee: marinaEmp._id, services: [styling._id],
      date: addDays(3), startTime: '15:30', totalDuration: styling.duration,
      totalPrice: styling.price, status: 'Scheduled',
    },
  ];
  const appointments = await Appointment.insertMany(appointmentsData);
  console.log(`Created ${appointments.length} appointments`);

  // --- Reviews (for completed appointments) ---
  const reviewsData = [
    {
      client: clients[0]._id, employee: barberEmp._id, appointment: appointments[0]._id,
      rating: 5, text: 'Чудова стрижка, дуже задоволений результатом!',
    },
    {
      client: clients[1]._id, employee: marinaEmp._id, appointment: appointments[1]._id,
      rating: 4, text: 'Все сподобалось, приємна атмосфера.',
    },
  ];
  await Review.insertMany(reviewsData);
  console.log(`Created ${reviewsData.length} reviews`);

  // --- Settings ---
  await Settings.create({
    shopName: 'BarberCRM',
    address: 'вул. Хрещатик, 1, Київ',
    phone: '+380441234567',
    email: 'info@barbershop.com',
  });
  console.log('Created settings');

  console.log('\nТестові акаунти:');
  console.log('  Admin:  admin@barbershop.com / admin123');
  console.log('  Barber: barber@barbershop.com / barber123');
  console.log('  Client: client@barbershop.com / client123');

  await mongoose.disconnect();
  console.log('\nSeeding complete.');
}

seed().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
